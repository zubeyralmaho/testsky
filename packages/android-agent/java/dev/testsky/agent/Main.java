package dev.testsky.agent;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * testsky's hands and eyes on an Android phone, run by the shell user through
 * app_process: nothing is installed, and nothing outlives the connection.
 *
 * One UiAutomation connection serves everything a step needs -- a picture,
 * the accessibility tree, touches, keys, typed text -- over one socket that
 * the host reaches with `adb forward`. It replaces a screencap, a uiautomator
 * dump and an `input` command per action, each of which is its own process on
 * the phone.
 *
 * The protocol is a line per request; each answer is a line "ok <length>" or
 * "err <reason>", then that many bytes. Coordinates are the display's pixels
 * in its current rotation, as `input` takes them. Text travels as base64.
 */
public final class Main {
  /** Said by "version", so a host can tell an agent left from an older build. */
  static final String VERSION = "0.2.0";
  private static final Object INPUT = new Object();
  /** When the screen last changed, by the accessibility events: what "settled" is measured from. */
  private static volatile long lastChangeAt = SystemClock.uptimeMillis();
  /** The text of the last toast, which no screenshot is sure to catch. */
  private static volatile String lastToast = "";
  private static volatile long lastToastAt = 0;

  public static void main(String[] args) throws Exception {
    int port = args.length > 0 ? Integer.parseInt(args[0]) : 27183;
    // app_process sets up no main looper, and the accessibility client builds
    // its handler on it: without one the first event killed the agent.
    Looper.prepareMainLooper();
    HandlerThread thread = new HandlerThread("testsky-uia");
    thread.start();
    UiAutomation ui = connect(thread.getLooper());
    ui.setOnAccessibilityEventListener(Main::onEvent);

    try (ServerSocket server = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))) {
      System.out.println("listening " + port + " " + VERSION);
      System.out.flush();
      // One client, and the agent ends with it: a host that went away leaves nothing behind.
      server.setSoTimeout(30_000);
      try (Socket client = server.accept()) {
        client.setTcpNoDelay(true);
        serve(ui, client);
      }
    } finally {
      disconnect(ui);
      thread.quitSafely();
    }
    System.exit(0);
  }

  private static void onEvent(AccessibilityEvent event) {
    int type = event.getEventType();
    if (type == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED) {
      CharSequence cls = event.getClassName();
      if (cls != null && cls.toString().contains("Toast")) {
        lastToast = String.valueOf(event.getText());
        lastToastAt = SystemClock.uptimeMillis();
      }
      return;
    }
    if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
        || type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        || type == AccessibilityEvent.TYPE_WINDOWS_CHANGED
        || type == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
      lastChangeAt = SystemClock.uptimeMillis();
    }
  }

  /** UiAutomation as the shell gets it -- the way `uiautomator` does -- leaving the phone's own accessibility services on. */
  private static UiAutomation connect(Looper looper) throws Exception {
    Class<?> connectionClass = Class.forName("android.app.UiAutomationConnection");
    Class<?> connectionInterface = Class.forName("android.app.IUiAutomationConnection");
    Object connection = connectionClass.getConstructor().newInstance();
    UiAutomation ui = null;
    for (Constructor<?> constructor : UiAutomation.class.getDeclaredConstructors()) {
      Class<?>[] params = constructor.getParameterTypes();
      if (params.length == 2 && params[0] == Looper.class && params[1] == connectionInterface) {
        constructor.setAccessible(true);
        ui = (UiAutomation) constructor.newInstance(looper, connection);
      }
    }
    if (ui == null) {
      // Newer releases take a Context in place of the Looper.
      Class<?> activityThread = Class.forName("android.app.ActivityThread");
      Object thread = activityThread.getMethod("systemMain").invoke(null);
      Object context = activityThread.getMethod("getSystemContext").invoke(thread);
      Constructor<?> constructor = UiAutomation.class.getDeclaredConstructor(Class.forName("android.content.Context"), connectionInterface);
      constructor.setAccessible(true);
      ui = (UiAutomation) constructor.newInstance(context, connection);
    }
    Method connect;
    try {
      connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
      connect.setAccessible(true);
      connect.invoke(ui, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    } catch (NoSuchMethodException e) {
      connect = UiAutomation.class.getDeclaredMethod("connect");
      connect.setAccessible(true);
      connect.invoke(ui);
    }
    AccessibilityServiceInfo info = ui.getServiceInfo();
    info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
    info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK;
    ui.setServiceInfo(info);
    return ui;
  }

  private static void disconnect(UiAutomation ui) {
    try {
      Method disconnect = UiAutomation.class.getDeclaredMethod("disconnect");
      disconnect.setAccessible(true);
      disconnect.invoke(ui);
    } catch (Exception ignored) {
      // The process is about to end; the system lets go of it then.
    }
  }

  private static void serve(UiAutomation ui, Socket client) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
    OutputStream out = client.getOutputStream();
    for (String line; (line = in.readLine()) != null; ) {
      String[] words = line.trim().split("\\s+", 2);
      String rest = words.length > 1 ? words[1] : "";
      try {
        byte[] answer;
        switch (words[0]) {
          case "ping": answer = utf8("pong"); break;
          case "version": answer = utf8(VERSION); break;
          case "info": answer = utf8(info(ui)); break;
          case "shot": answer = shot(ui, rest); break;
          case "tree": answer = utf8(tree(ui, rest.trim().equals("all"))); break;
          case "tap": answer = tap(ui, rest); break;
          case "doubletap": answer = doubleTap(ui, rest); break;
          case "swipe": answer = swipe(ui, rest); break;
          case "key": answer = key(ui, Integer.parseInt(rest.trim())); break;
          case "global": answer = utf8(ui.performGlobalAction(Integer.parseInt(rest.trim())) ? "done" : "refused"); break;
          case "type": answer = utf8(type(ui, new String(Base64.decode(rest.trim(), Base64.DEFAULT), StandardCharsets.UTF_8))); break;
          case "clear": answer = utf8(clear(ui)); break;
          case "quiet": answer = utf8(quiet()); break;
          case "quit": reply(out, utf8("bye")); return;
          default: throw new IllegalArgumentException("unknown request: " + words[0]);
        }
        reply(out, answer);
      } catch (Throwable error) {
        String reason = String.valueOf(error.getMessage()).replace('\n', ' ');
        out.write(utf8("err " + error.getClass().getSimpleName() + ": " + reason + "\n"));
        out.flush();
      }
    }
  }

  private static byte[] utf8(String text) {
    return text.getBytes(StandardCharsets.UTF_8);
  }

  private static void reply(OutputStream out, byte[] payload) throws Exception {
    out.write(utf8("ok " + payload.length + "\n"));
    out.write(payload);
    out.flush();
  }

  /** The display as it is now: its size in pixels in the current rotation, the rotation, its density, and whether a keyboard is up. */
  private static String info(UiAutomation ui) throws Exception {
    int width = 0, height = 0, rotation = 0, density = 0;
    try {
      Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
      Object manager = global.getMethod("getInstance").invoke(null);
      Object display = global.getMethod("getDisplayInfo", int.class).invoke(manager, 0);
      width = intField(display, "logicalWidth");
      height = intField(display, "logicalHeight");
      rotation = intField(display, "rotation");
      density = intField(display, "logicalDensityDpi");
    } catch (Throwable unknown) {
      Bitmap screen = ui.takeScreenshot();
      if (screen != null) {
        width = screen.getWidth();
        height = screen.getHeight();
      }
    }
    return "{\"width\":" + width + ",\"height\":" + height + ",\"rotation\":" + rotation + ",\"density\":" + density + ",\"ime\":" + keyboardUp(ui) + "}";
  }

  private static int intField(Object target, String name) throws Exception {
    Field field = target.getClass().getDeclaredField(name);
    field.setAccessible(true);
    return field.getInt(target);
  }

  private static boolean keyboardUp(UiAutomation ui) {
    for (AccessibilityWindowInfo window : ui.getWindows()) {
      if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
    }
    return false;
  }

  /** "shot <scale 0-1> <jpeg quality>": the screen as a JPEG, scaled on the phone so that little crosses the cable. */
  private static byte[] shot(UiAutomation ui, String args) {
    String[] parts = args.trim().isEmpty() ? new String[0] : args.trim().split("\\s+");
    float scale = parts.length > 0 ? Float.parseFloat(parts[0]) : 1f;
    int quality = parts.length > 1 ? Integer.parseInt(parts[1]) : 85;
    Bitmap screen = ui.takeScreenshot();
    if (screen == null) throw new IllegalStateException("no screenshot");
    Bitmap soft = screen.getConfig() == Bitmap.Config.HARDWARE ? screen.copy(Bitmap.Config.ARGB_8888, false) : screen;
    Bitmap sized = scale >= 0.999f ? soft : Bitmap.createScaledBitmap(soft, Math.max(1, Math.round(soft.getWidth() * scale)), Math.max(1, Math.round(soft.getHeight() * scale)), true);
    ByteArrayOutputStream jpeg = new ByteArrayOutputStream(256 * 1024);
    sized.compress(Bitmap.CompressFormat.JPEG, quality, jpeg);
    return jpeg.toByteArray();
  }

  /**
   * "tree [all]": the active window's tree -- the window uiautomator and yadb
   * dump -- or, with "all", every window on the screen, system dialogs and
   * heads-up banners included.
   */
  private static String tree(UiAutomation ui, boolean all) {
    StringBuilder json = new StringBuilder(64 * 1024);
    List<AccessibilityWindowInfo> windows = ui.getWindows();
    json.append("{\"windows\":[");
    boolean first = true;
    boolean found = false;
    for (AccessibilityWindowInfo window : windows) {
      if (!all && !window.isActive()) continue;
      AccessibilityNodeInfo root = window.getRoot();
      if (!all && root == null) continue;
      if (!first) json.append(',');
      first = false;
      found = true;
      window(json, window.getType(), window.getLayer(), window.isActive(), window.getTitle(), window, root);
      if (!all) break;
    }
    if (!all && !found) {
      AccessibilityNodeInfo root = ui.getRootInActiveWindow();
      if (root != null) window(json, AccessibilityWindowInfo.TYPE_APPLICATION, 0, true, null, null, root);
    }
    json.append("]}");
    return json.toString();
  }

  private static void window(StringBuilder json, int type, int layer, boolean active, CharSequence title, AccessibilityWindowInfo window, AccessibilityNodeInfo root) {
    json.append("{\"type\":").append(type).append(",\"layer\":").append(layer).append(",\"active\":").append(active).append(",\"title\":");
    string(json, title);
    if (window != null) {
      Rect bounds = new Rect();
      window.getBoundsInScreen(bounds);
      json.append(",\"bounds\":");
      rect(json, bounds);
    }
    json.append(",\"root\":");
    if (root == null) json.append("null");
    else node(json, root, 0);
    json.append('}');
  }

  private static void node(StringBuilder json, AccessibilityNodeInfo node, int depth) {
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    json.append("{\"class\":");
    string(json, node.getClassName());
    CharSequence text = node.getText();
    if (text != null && !(android.os.Build.VERSION.SDK_INT >= 26 && node.isShowingHintText())) { json.append(",\"text\":"); string(json, text); }
    if (node.getContentDescription() != null) { json.append(",\"desc\":"); string(json, node.getContentDescription()); }
    if (node.getViewIdResourceName() != null) { json.append(",\"id\":"); string(json, node.getViewIdResourceName()); }
    if (node.getPackageName() != null) { json.append(",\"pkg\":"); string(json, node.getPackageName()); }
    json.append(",\"bounds\":");
    rect(json, bounds);
    int flags = (node.isClickable() ? 1 : 0) | (node.isLongClickable() ? 2 : 0) | (node.isScrollable() ? 4 : 0)
        | (node.isCheckable() ? 8 : 0) | (node.isChecked() ? 16 : 0) | (node.isEditable() ? 32 : 0)
        | (node.isEnabled() ? 64 : 0) | (node.isFocused() ? 128 : 0) | (node.isSelected() ? 256 : 0)
        | (node.isVisibleToUser() ? 512 : 0) | (node.isPassword() ? 1024 : 0) | (node.isFocusable() ? 2048 : 0);
    json.append(",\"f\":").append(flags);
    int count = depth > 80 ? 0 : node.getChildCount();
    if (count > 0) {
      json.append(",\"children\":[");
      boolean first = true;
      for (int i = 0; i < count; i++) {
        AccessibilityNodeInfo child = node.getChild(i);
        if (child == null) continue;
        if (!first) json.append(',');
        first = false;
        node(json, child, depth + 1);
      }
      json.append(']');
    }
    json.append('}');
  }

  private static void rect(StringBuilder json, Rect r) {
    json.append('[').append(r.left).append(',').append(r.top).append(',').append(r.right).append(',').append(r.bottom).append(']');
  }

  private static void string(StringBuilder json, CharSequence text) {
    if (text == null) { json.append("null"); return; }
    json.append('"');
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      switch (c) {
        case '"': json.append("\\\""); break;
        case '\\': json.append("\\\\"); break;
        case '\n': json.append("\\n"); break;
        case '\r': json.append("\\r"); break;
        case '\t': json.append("\\t"); break;
        default:
          if (c < 0x20 || c == 0x2028 || c == 0x2029) json.append(String.format("\\u%04x", (int) c));
          else json.append(c);
      }
    }
    json.append('"');
  }

  private static boolean inject(UiAutomation ui, InputEvent event) {
    synchronized (INPUT) {
      return ui.injectInputEvent(event, true);
    }
  }

  private static MotionEvent touch(long down, long at, int action, float x, float y) {
    MotionEvent event = MotionEvent.obtain(down, at, action, x, y, 0);
    event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    return event;
  }

  private static boolean press(UiAutomation ui, float x, float y, long hold) throws InterruptedException {
    long down = SystemClock.uptimeMillis();
    boolean ok = inject(ui, touch(down, down, MotionEvent.ACTION_DOWN, x, y));
    if (hold > 0) Thread.sleep(hold);
    ok &= inject(ui, touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y));
    return ok;
  }

  private static byte[] done(boolean ok) {
    return utf8(ok ? "done" : "refused");
  }

  /** "tap <x> <y> [hold ms]": a finger down and up; held long, a long press. */
  private static byte[] tap(UiAutomation ui, String args) throws InterruptedException {
    String[] p = args.trim().split("\\s+");
    return done(press(ui, Float.parseFloat(p[0]), Float.parseFloat(p[1]), p.length > 2 ? Long.parseLong(p[2]) : 60));
  }

  /** "doubletap <x> <y>": two taps close enough together to be one double tap. */
  private static byte[] doubleTap(UiAutomation ui, String args) throws InterruptedException {
    String[] p = args.trim().split("\\s+");
    float x = Float.parseFloat(p[0]), y = Float.parseFloat(p[1]);
    boolean ok = press(ui, x, y, 30);
    Thread.sleep(70);
    ok &= press(ui, x, y, 30);
    return done(ok);
  }

  /**
   * "swipe <x1> <y1> <x2> <y2> <ms> [stop ms]": a finger drawn from one point
   * to another. With a stop, it rests at the end before lifting, so a list
   * stops where the finger does instead of flinging on.
   */
  private static byte[] swipe(UiAutomation ui, String args) throws InterruptedException {
    String[] p = args.trim().split("\\s+");
    float x1 = Float.parseFloat(p[0]), y1 = Float.parseFloat(p[1]), x2 = Float.parseFloat(p[2]), y2 = Float.parseFloat(p[3]);
    long duration = Math.max(1, Long.parseLong(p[4]));
    long stop = p.length > 5 ? Long.parseLong(p[5]) : 0;
    long down = SystemClock.uptimeMillis();
    boolean ok = inject(ui, touch(down, down, MotionEvent.ACTION_DOWN, x1, y1));
    for (long now = SystemClock.uptimeMillis(); now - down < duration; now = SystemClock.uptimeMillis()) {
      float t = (now - down) / (float) duration;
      ok &= inject(ui, touch(down, now, MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t));
      Thread.sleep(8);
    }
    ok &= inject(ui, touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, x2, y2));
    for (long until = SystemClock.uptimeMillis() + stop; SystemClock.uptimeMillis() < until; ) {
      ok &= inject(ui, touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, x2, y2));
      Thread.sleep(16);
    }
    ok &= inject(ui, touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x2, y2));
    return done(ok);
  }

  private static boolean keyPress(UiAutomation ui, int code) {
    long now = SystemClock.uptimeMillis();
    boolean ok = inject(ui, new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
    ok &= inject(ui, new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD));
    return ok;
  }

  /** "key <keycode>": a key pressed and let go. */
  private static byte[] key(UiAutomation ui, int code) {
    return done(keyPress(ui, code));
  }

  /** The field that takes typing now: the one with the input focus, in whichever window has it. */
  private static AccessibilityNodeInfo focusedField(UiAutomation ui) {
    for (AccessibilityWindowInfo window : ui.getWindows()) {
      AccessibilityNodeInfo root = window.getRoot();
      if (root == null) continue;
      AccessibilityNodeInfo field = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
      if (field != null && field.isEditable()) return field;
    }
    return null;
  }

  private static String textOf(AccessibilityNodeInfo field) {
    field.refresh();
    if (android.os.Build.VERSION.SDK_INT >= 26 && field.isShowingHintText()) return "";
    return field.getText() == null ? "" : field.getText().toString();
  }

  /**
   * "type <base64>": the text added to the focused field as a whole -- any
   * language, no keyboard -- answered with what the field holds after. With no
   * field focused, it is typed key by key, which only the keyboard's own
   * characters survive.
   */
  private static String type(UiAutomation ui, String text) {
    AccessibilityNodeInfo field = focusedField(ui);
    if (field != null) {
      Bundle arguments = new Bundle();
      arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, textOf(field) + text);
      if (field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return textOf(field);
    }
    KeyEvent[] events = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
    if (events == null) throw new IllegalStateException("no field has the input focus, and the text has characters no key makes");
    boolean ok = true;
    for (KeyEvent event : events) ok &= inject(ui, event);
    if (!ok) throw new IllegalStateException("the keys were refused");
    AccessibilityNodeInfo after = focusedField(ui);
    return after == null ? "" : textOf(after);
  }

  /** "clear": the focused field emptied, or, with none to set, deleted from the end a key at a time. */
  private static String clear(UiAutomation ui) {
    AccessibilityNodeInfo field = focusedField(ui);
    if (field != null) {
      Bundle arguments = new Bundle();
      arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "");
      if (field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return textOf(field);
    }
    keyPress(ui, KeyEvent.KEYCODE_MOVE_END);
    for (int i = 0; i < 100; i++) {
      keyPress(ui, KeyEvent.KEYCODE_DEL);
      keyPress(ui, KeyEvent.KEYCODE_FORWARD_DEL);
    }
    AccessibilityNodeInfo after = focusedField(ui);
    return after == null ? "" : textOf(after);
  }

  /** "quiet": how long since the screen last changed, by the phone's own word, and the last toast. */
  private static String quiet() {
    long now = SystemClock.uptimeMillis();
    StringBuilder json = new StringBuilder("{\"quietMs\":").append(now - lastChangeAt);
    if (lastToastAt > 0) {
      json.append(",\"toastAgoMs\":").append(now - lastToastAt).append(",\"toast\":");
      string(json, lastToast);
    }
    return json.append('}').toString();
  }
}
