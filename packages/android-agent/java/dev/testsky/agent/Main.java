package dev.testsky.agent;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
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
 * every window's accessibility tree, touches, keys, typed text -- over one
 * socket that the host reaches with `adb forward`. It replaces a screencap, a
 * uiautomator dump and an `input` command per action, each of which is its own
 * process on the phone.
 *
 * The protocol is a line per request; each answer is a line "ok <length>" or
 * "err <reason>", then that many bytes. Coordinates are the display's pixels
 * in its current rotation, as `input` takes them.
 */
public final class Main {
  private static final Object LOCK = new Object();
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
      System.out.println("listening " + port);
      System.out.flush();
      // One client at a time, and the agent ends with it: a host that went away leaves nothing behind.
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
          case "ping": answer = "pong".getBytes(StandardCharsets.UTF_8); break;
          case "shot": answer = shot(ui, rest); break;
          case "tree": answer = tree(ui).getBytes(StandardCharsets.UTF_8); break;
          case "tap": answer = tap(ui, rest); break;
          case "swipe": answer = swipe(ui, rest); break;
          case "key": answer = key(ui, Integer.parseInt(rest.trim())); break;
          case "settext": answer = setText(ui, rest); break;
          case "quiet": answer = quiet().getBytes(StandardCharsets.UTF_8); break;
          case "quit": reply(out, "bye".getBytes(StandardCharsets.UTF_8)); return;
          default: throw new IllegalArgumentException("unknown request: " + words[0]);
        }
        reply(out, answer);
      } catch (Throwable error) {
        String reason = String.valueOf(error.getMessage()).replace('\n', ' ');
        out.write(("err " + error.getClass().getSimpleName() + ": " + reason + "\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
      }
    }
  }

  private static void reply(OutputStream out, byte[] payload) throws Exception {
    out.write(("ok " + payload.length + "\n").getBytes(StandardCharsets.UTF_8));
    out.write(payload);
    out.flush();
  }

  /** "shot <scale 0-1> <jpeg quality>": the screen as a JPEG, scaled on the phone so that little crosses the cable. */
  private static byte[] shot(UiAutomation ui, String args) {
    String[] parts = args.trim().isEmpty() ? new String[0] : args.trim().split("\\s+");
    float scale = parts.length > 0 ? Float.parseFloat(parts[0]) : 1f;
    int quality = parts.length > 1 ? Integer.parseInt(parts[1]) : 80;
    Bitmap screen = ui.takeScreenshot();
    if (screen == null) throw new IllegalStateException("no screenshot");
    Bitmap soft = screen.getConfig() == Bitmap.Config.HARDWARE ? screen.copy(Bitmap.Config.ARGB_8888, false) : screen;
    Bitmap sized = scale >= 0.999f ? soft : Bitmap.createScaledBitmap(soft, Math.max(1, Math.round(soft.getWidth() * scale)), Math.max(1, Math.round(soft.getHeight() * scale)), true);
    ByteArrayOutputStream jpeg = new ByteArrayOutputStream(256 * 1024);
    sized.compress(Bitmap.CompressFormat.JPEG, quality, jpeg);
    return jpeg.toByteArray();
  }

  /** Every window on the screen, top first by layer, each with its tree: system dialogs and heads-up banners included. */
  private static String tree(UiAutomation ui) {
    StringBuilder json = new StringBuilder(64 * 1024);
    List<AccessibilityWindowInfo> windows = ui.getWindows();
    json.append("{\"windows\":[");
    boolean first = true;
    for (AccessibilityWindowInfo window : windows) {
      if (!first) json.append(',');
      first = false;
      Rect bounds = new Rect();
      window.getBoundsInScreen(bounds);
      json.append("{\"type\":").append(window.getType())
          .append(",\"layer\":").append(window.getLayer())
          .append(",\"active\":").append(window.isActive())
          .append(",\"title\":");
      string(json, window.getTitle());
      json.append(",\"bounds\":");
      rect(json, bounds);
      json.append(",\"root\":");
      AccessibilityNodeInfo root = window.getRoot();
      if (root == null) json.append("null");
      else node(json, root, 0);
      json.append('}');
    }
    json.append("]}");
    return json.toString();
  }

  private static void node(StringBuilder json, AccessibilityNodeInfo node, int depth) {
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    json.append("{\"class\":");
    string(json, node.getClassName());
    if (node.getText() != null) { json.append(",\"text\":"); string(json, node.getText()); }
    if (node.getContentDescription() != null) { json.append(",\"desc\":"); string(json, node.getContentDescription()); }
    if (node.getViewIdResourceName() != null) { json.append(",\"id\":"); string(json, node.getViewIdResourceName()); }
    json.append(",\"bounds\":");
    rect(json, bounds);
    int flags = (node.isClickable() ? 1 : 0) | (node.isLongClickable() ? 2 : 0) | (node.isScrollable() ? 4 : 0)
        | (node.isCheckable() ? 8 : 0) | (node.isChecked() ? 16 : 0) | (node.isEditable() ? 32 : 0)
        | (node.isEnabled() ? 64 : 0) | (node.isFocused() ? 128 : 0) | (node.isSelected() ? 256 : 0)
        | (node.isVisibleToUser() ? 512 : 0) | (node.isPassword() ? 1024 : 0);
    json.append(",\"f\":").append(flags);
    int count = depth > 60 ? 0 : node.getChildCount();
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
          if (c < 0x20) json.append(String.format("\\u%04x", (int) c));
          else json.append(c);
      }
    }
    json.append('"');
  }

  private static boolean inject(UiAutomation ui, android.view.InputEvent event) {
    synchronized (LOCK) {
      return ui.injectInputEvent(event, true);
    }
  }

  private static MotionEvent touch(long down, long at, int action, float x, float y) {
    MotionEvent event = MotionEvent.obtain(down, at, action, x, y, 0);
    event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
    return event;
  }

  /** "tap <x> <y> [hold ms]": a finger down and up. */
  private static byte[] tap(UiAutomation ui, String args) throws InterruptedException {
    String[] p = args.trim().split("\\s+");
    float x = Float.parseFloat(p[0]), y = Float.parseFloat(p[1]);
    long hold = p.length > 2 ? Long.parseLong(p[2]) : 40;
    long down = SystemClock.uptimeMillis();
    boolean ok = inject(ui, touch(down, down, MotionEvent.ACTION_DOWN, x, y));
    Thread.sleep(hold);
    ok &= inject(ui, touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y));
    return (ok ? "done" : "refused").getBytes(StandardCharsets.UTF_8);
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
    if (stop > 0) {
      for (long until = SystemClock.uptimeMillis() + stop; SystemClock.uptimeMillis() < until; ) {
        ok &= inject(ui, touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_MOVE, x2, y2));
        Thread.sleep(16);
      }
    }
    ok &= inject(ui, touch(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x2, y2));
    return (ok ? "done" : "refused").getBytes(StandardCharsets.UTF_8);
  }

  /** "key <keycode>": a key pressed and let go. */
  private static byte[] key(UiAutomation ui, int code) {
    long now = SystemClock.uptimeMillis();
    boolean ok = inject(ui, new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, 0, -1, 0, 0, InputDevice.SOURCE_KEYBOARD));
    ok &= inject(ui, new KeyEvent(now, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, code, 0, 0, -1, 0, 0, InputDevice.SOURCE_KEYBOARD));
    return (ok ? "done" : "refused").getBytes(StandardCharsets.UTF_8);
  }

  /** "settext <text>": the focused field's text set as a whole -- any language, no keyboard -- and read back. */
  private static byte[] setText(UiAutomation ui, String text) {
    AccessibilityNodeInfo field = null;
    for (AccessibilityWindowInfo window : ui.getWindows()) {
      AccessibilityNodeInfo root = window.getRoot();
      if (root == null) continue;
      field = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
      if (field != null) break;
    }
    if (field == null) throw new IllegalStateException("no field has the input focus");
    Bundle arguments = new Bundle();
    arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
    if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) throw new IllegalStateException("the field refused the text");
    field.refresh();
    CharSequence now = field.getText();
    return String.valueOf(now).getBytes(StandardCharsets.UTF_8);
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
