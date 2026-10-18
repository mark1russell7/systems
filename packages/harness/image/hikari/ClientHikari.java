// client-hikari HOST PORT --mode idle|inflight|stream [--interval-ms N] [--max-s N] [--go PATH]
//               [--query TEXT] [--before] [--options JSON]
//
// The client of a HikariCP cell: HikariCP 7.1.0 over pgjdbc 42.7.13, on Java 21. Each event is a
// JSON line with `ev` and `t`, the time on CLOCK_MONOTONIC in nanoseconds (System.nanoTime, which
// the JVM reads from it on Linux). The prober stamps the records of the kernel on the same clock,
// and the injector stamps each fault on it.
//
// The lines:
// - start: the versions of HikariCP, pgjdbc and Java, the mode and the options.
// - connecting: the start of the pool and of its first connection. Its stamp is the stamp of the
//   first sent line.
// - socket: each connection that the client borrows, with its local address, at its first borrow.
// - connected: the first socket. The TCP client of the harness names its own socket so.
// - pool: each change of the counts of the pool: total, active, idle and waiting.
// - ready: the reply to the first query: the connection is idle in the pool (idle, inflight), or
//   the stream starts (stream).
// - sent, ack, fail: each query by its sequence number, with its error.
// - data, error: the end of the query in flight, as the TCP client of the harness tells it. In idle
//   mode, the close of the socket of the first connection is an error line too: the pool closed it.
// - done, deadline: the end of the client.
//
// The modes are those of the pg client. idle sends one query, closes its connection (the
// connection goes back to the pool), then holds until --max-s. inflight sends one query, waits for
// the file --go, sends one more query into the fault, and holds after its end. stream sends a query
// each --interval-ms after the reply before. --before starts the client into a fault that holds
// already: the start of its pool meets it.
//
// The options are one flat JSON object. A name with the prefix `dataSource.` is a property of
// pgjdbc. Each other name is a property of HikariConfig. A cell gives each option that it changes,
// and HikariCP and pgjdbc give the others.

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import com.zaxxer.hikari.HikariPoolMXBean;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.lang.reflect.Field;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.postgresql.core.PGStream;
import org.postgresql.jdbc.PgConnection;

public final class ClientHikari {
  private static final PrintStream OUT = new PrintStream(new FileOutputStream(FileDescriptor.out), false, StandardCharsets.UTF_8);
  private static final Object LOCK = new Object();
  private static final Set<String> SEEN = ConcurrentHashMap.newKeySet();
  private static volatile boolean stopped = false;
  private static volatile HikariDataSource pool;
  private static volatile String connected;
  private static volatile Socket observed;
  private static String host;
  private static String port;
  private static String query;
  private static HikariConfig config;

  private ClientHikari() {}

  private static long now() {
    return System.nanoTime();
  }

  /** This function writes one line: its event, its stamp, and the JSON fields after them. */
  private static void emit(String ev, long t, String fields) {
    String line = "{\"ev\":" + q(ev) + ",\"t\":" + t + (fields.isEmpty() ? "" : "," + fields) + "}\n";
    synchronized (LOCK) {
      OUT.print(line);
      OUT.flush();
    }
  }

  private static void emit(String ev, String fields) {
    emit(ev, now(), fields);
  }

  /** This function gives a text as a JSON string, or null. */
  private static String q(String text) {
    if (text == null) return "null";
    StringBuilder out = new StringBuilder("\"");
    for (char c : text.toCharArray()) {
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    return out.append('"').toString();
  }

  private static String flag(List<String> argv, String name, String otherwise) {
    int at = argv.indexOf(name);
    return at == -1 || at + 1 >= argv.size() ? otherwise : argv.get(at + 1);
  }

  // ---- the options: a flat JSON object of names to numbers, texts, true, false or null

  private static Map<String, String> parseObject(String text) {
    Map<String, String> out = new LinkedHashMap<>();
    int[] at = {0};
    skip(text, at);
    expect(text, at, '{');
    skip(text, at);
    if (peek(text, at) == '}') return out;
    for (;;) {
      skip(text, at);
      String name = parseString(text, at);
      skip(text, at);
      expect(text, at, ':');
      skip(text, at);
      String value = parseValue(text, at);
      if (value != null) out.put(name, value);
      skip(text, at);
      char next = text.charAt(at[0]++);
      if (next == '}') return out;
      if (next != ',') throw new IllegalArgumentException("the options are not a flat JSON object: " + text);
    }
  }

  private static char peek(String text, int[] at) {
    return text.charAt(at[0]);
  }

  private static void skip(String text, int[] at) {
    while (at[0] < text.length() && Character.isWhitespace(text.charAt(at[0]))) at[0]++;
  }

  private static void expect(String text, int[] at, char c) {
    if (text.charAt(at[0]++) != c) throw new IllegalArgumentException("the options are not a flat JSON object: " + text);
  }

  private static String parseString(String text, int[] at) {
    expect(text, at, '"');
    StringBuilder out = new StringBuilder();
    for (;;) {
      char c = text.charAt(at[0]++);
      if (c == '"') return out.toString();
      if (c == '\\') {
        char e = text.charAt(at[0]++);
        switch (e) {
          case 'n' -> out.append('\n');
          case 't' -> out.append('\t');
          case 'r' -> out.append('\r');
          case 'u' -> {
            out.append((char) Integer.parseInt(text.substring(at[0], at[0] + 4), 16));
            at[0] += 4;
          }
          default -> out.append(e);
        }
      } else out.append(c);
    }
  }

  private static String parseValue(String text, int[] at) {
    char c = peek(text, at);
    if (c == '"') return parseString(text, at);
    int from = at[0];
    while (at[0] < text.length() && ",} \t\r\n".indexOf(text.charAt(at[0])) == -1) at[0]++;
    String word = text.substring(from, at[0]);
    if (word.equals("null")) return null;
    // a whole number in a JSON number of the cell (30000.0) is a whole number for a setter of HikariConfig
    if (word.endsWith(".0")) return word.substring(0, word.length() - 2);
    return word;
  }

  // ---- the error of a query as data

  private static Throwable rootOf(Throwable error) {
    Throwable at = error;
    while (at.getCause() != null && at.getCause() != at) at = at.getCause();
    return at;
  }

  /** This function gives the first SQLException in the causes of an error: the start of a pool wraps the one of pgjdbc. */
  private static SQLException sqlOf(Throwable error) {
    for (Throwable at = error; at != null; at = at.getCause() == at ? null : at.getCause()) {
      if (at instanceof SQLException sql) return sql;
    }
    return null;
  }

  private static String failure(Throwable error) {
    SQLException sql = sqlOf(error);
    String state = sql == null ? null : sql.getSQLState();
    Integer code = sql == null ? null : sql.getErrorCode();
    Throwable root = rootOf(error);
    return "\"name\":" + q(error.getClass().getSimpleName())
        + ",\"sqlState\":" + q(state)
        + ",\"code\":" + (code == null ? "null" : code)
        + ",\"message\":" + q(error.getMessage())
        + ",\"cause\":" + (root == error ? "null" : "{\"name\":" + q(root.getClass().getSimpleName()) + ",\"message\":" + q(root.getMessage()) + "}");
  }

  /** This function gives the errno of an error: the SQLState of pgjdbc or HikariCP, or the message. */
  private static String errnoOf(Throwable error) {
    SQLException sql = sqlOf(error);
    if (sql != null && sql.getSQLState() != null) return sql.getSQLState();
    return error.getMessage();
  }

  // ---- each connection that the client borrows: its socket, read from pgjdbc

  /** This function gives the socket of a connection, from the PGStream of pgjdbc, or null. */
  private static Socket socketOf(Connection connection) {
    try {
      PgConnection pg = connection.unwrap(PgConnection.class);
      Object executor = pg.getQueryExecutor();
      Field field = null;
      for (Class<?> at = executor.getClass(); at != null && field == null; at = at.getSuperclass()) {
        try {
          field = at.getDeclaredField("pgStream");
        } catch (NoSuchFieldException absent) {
          // the field is on a superclass
        }
      }
      if (field == null) return null;
      field.setAccessible(true);
      return ((PGStream) field.get(executor)).getSocket();
    } catch (Exception error) {
      return null;
    }
  }

  private static void seen(Connection connection) {
    Socket socket = socketOf(connection);
    if (socket == null) return;
    String local = socket.getLocalAddress().getHostAddress() + ":" + socket.getLocalPort();
    if (!SEEN.add(local)) return;
    emit("socket", "\"role\":\"pool\",\"local\":" + q(local));
    if (connected == null) {
      connected = local;
      observed = socket;
      emit("connected", "\"local\":" + q(local));
    }
  }

  /**
   * This function watches the socket of the first connection in idle mode, each 2 ms. The pool
   * closes it when a check finds it dead: pgjdbc closes the socket after a read timeout or an I/O
   * error. That close is the detection of an idle cell, thus it writes an error line.
   */
  private static void watchIdle() {
    Socket socket = observed;
    if (socket == null) return;
    Thread watcher = new Thread(() -> {
      while (!stopped) {
        if (socket.isClosed()) {
          emit("error", "\"errno\":\"CLOSED\",\"local\":" + q(connected));
          return;
        }
        try {
          Thread.sleep(2);
        } catch (InterruptedException stop) {
          return;
        }
      }
    }, "idle-watcher");
    watcher.setDaemon(true);
    watcher.start();
  }

  // ---- the counts of the pool, each 5 ms: a line for each change

  private static void watchPool() {
    Thread watcher = new Thread(() -> {
      String last = "";
      while (!stopped) {
        HikariDataSource ds = pool;
        if (ds != null) {
          try {
            HikariPoolMXBean bean = ds.getHikariPoolMXBean();
            if (bean != null) {
              String counts = "\"total\":" + bean.getTotalConnections()
                  + ",\"active\":" + bean.getActiveConnections()
                  + ",\"idle\":" + bean.getIdleConnections()
                  + ",\"waiting\":" + bean.getThreadsAwaitingConnection();
              if (!counts.equals(last)) {
                emit("pool", counts);
                last = counts;
              }
            }
          } catch (RuntimeException closed) {
            // the pool closed
          }
        }
        try {
          Thread.sleep(5);
        } catch (InterruptedException stop) {
          return;
        }
      }
    }, "pool-watcher");
    watcher.setDaemon(true);
    watcher.start();
  }

  // ---- the end of the client

  private static void stop(int code) {
    synchronized (LOCK) {
      if (stopped) return;
      stopped = true;
    }
    emit("done", "");
    HikariDataSource ds = pool;
    if (ds != null) {
      Thread closer = new Thread(ds::close, "pool-closer");
      closer.setDaemon(true);
      closer.start();
      try {
        closer.join(1000);
      } catch (InterruptedException stopNow) {
        // the exit goes on
      }
    }
    Runtime.getRuntime().halt(code);
  }

  /** This function sends query n through the pool. Its stamp is before the borrow. It gives null for a reply, or the error. */
  private static Throwable operate(int n) {
    long at = now();
    if (n == 1) emit("connecting", at, "\"at\":" + q(host + ":" + port));
    emit("sent", at, "\"n\":" + n);
    try {
      // the first query starts the pool: its check of initializationFailTimeout makes the first connection
      if (pool == null) pool = new HikariDataSource(config);
      long rows = 0;
      try (Connection connection = pool.getConnection()) {
        seen(connection);
        try (Statement statement = connection.createStatement()) {
          if (statement.execute(query)) {
            try (ResultSet result = statement.getResultSet()) {
              while (result.next()) rows += 1;
            }
          } else rows = statement.getUpdateCount();
        }
      }
      emit("ack", "\"n\":" + n + ",\"rows\":" + rows);
      return null;
    } catch (Throwable error) {
      emit("fail", "\"n\":" + n + "," + failure(error));
      return error;
    }
  }

  /**
   * This function loads the code of a connect and of the start of a pool before the first line, on
   * the loopback of the namespace. A new JVM loads each class at its first use, and that load would
   * be in the band of a cell that starts into a fault. A pool with no check and no idle connection
   * makes no connection: it loads the classes of the pool. It also sets the login timeout of
   * DriverManager, thus pgjdbc then connects in a task of an executor (Driver.java:303-311,
   * :730-739). A connect to port 1 of the loopback after it is refused at once: it loads that
   * connect of pgjdbc and its errors. HikariCP gives each new connection a random UUID (PoolBase.java:363), and the
   * first one starts the SecureRandom of the JVM.
   */
  private static void warmUp() {
    HikariConfig empty = new HikariConfig();
    empty.setJdbcUrl("jdbc:postgresql://127.0.0.1:1/warmup");
    empty.setUsername("warmup");
    empty.setPoolName("warmup");
    empty.setInitializationFailTimeout(-1);
    empty.setMinimumIdle(0);
    // the pool starts and closes with no connection
    new HikariDataSource(empty).close();
    Properties refused = new Properties();
    refused.setProperty("user", "warmup");
    try {
      new org.postgresql.Driver().connect("jdbc:postgresql://127.0.0.1:1/warmup", refused);
    } catch (SQLException expected) {
      // the refusal is the purpose of the connect
    }
    java.util.UUID.randomUUID();
  }

  public static void main(String[] args) throws Exception {
    List<String> argv = List.of(args);
    String mode = flag(argv, "--mode", null);
    if (args.length < 2 || mode == null || !List.of("idle", "inflight", "stream").contains(mode)) {
      emit("fail", "\"why\":\"client-hikari HOST PORT --mode idle|inflight|stream\"");
      Runtime.getRuntime().halt(1);
    }
    host = args[0];
    port = args[1];
    long interval = Long.parseLong(flag(argv, "--interval-ms", "50"));
    long max = Long.parseLong(flag(argv, "--max-s", "120")) * 1000;
    Path go = Path.of(flag(argv, "--go", "/tmp/go"));
    query = flag(argv, "--query", "SELECT 1");
    boolean before = argv.contains("--before");
    Map<String, String> options = parseObject(flag(argv, "--options", "{}"));
    warmUp();

    String bootId;
    try {
      bootId = Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).trim();
    } catch (Exception absent) {
      bootId = null;
    }
    StringBuilder given = new StringBuilder("{");
    for (Map.Entry<String, String> each : options.entrySet()) {
      if (given.length() > 1) given.append(',');
      given.append(q(each.getKey())).append(':').append(q(each.getValue()));
    }
    given.append('}');
    String hikari = HikariDataSource.class.getPackage().getImplementationVersion();
    emit("start", "\"boot_id\":" + q(bootId)
        + ",\"client\":\"hikari\",\"driver\":" + q(org.postgresql.util.DriverInfo.DRIVER_VERSION)
        + ",\"pool\":" + q(hikari == null ? "7.1.0" : hikari)
        + ",\"java\":" + q(System.getProperty("java.version"))
        + ",\"mode\":" + q(mode) + ",\"query\":" + q(query) + ",\"options\":" + given);

    Properties properties = new Properties();
    for (Map.Entry<String, String> each : options.entrySet()) properties.setProperty(each.getKey(), each.getValue());
    config = new HikariConfig(properties);
    config.setJdbcUrl("jdbc:postgresql://" + host + ":" + port + "/postgres");
    config.setUsername("postgres");
    config.setPoolName("cell");

    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      // SIGTERM: the end of the client, with exit code 0, as the pg client gives
      synchronized (LOCK) {
        if (stopped) return;
        stopped = true;
      }
      emit("done", "");
      Runtime.getRuntime().halt(0);
    }, "sigterm"));
    Thread deadline = new Thread(() -> {
      try {
        Thread.sleep(max);
      } catch (InterruptedException stop) {
        return;
      }
      emit("deadline", "");
      stop(0);
    }, "deadline");
    deadline.setDaemon(true);
    deadline.start();
    watchPool();

    if (mode.equals("stream")) {
      emit("ready", "\"at\":" + q(host + ":" + port));
      for (int n = 1; !stopped; n += 1) {
        operate(n);
        Thread.sleep(interval);
      }
      return;
    }
    // the first query makes the connection of the pool. Its reply is the last data before the fault
    Throwable failed = operate(1);
    if (failed != null) {
      emit("error", "\"errno\":" + q(errnoOf(failed)) + ",\"message\":" + q(failed.getMessage()));
      stop(before ? 0 : 1);
      return;
    }
    // the connection went back to the pool at the end of the query: it is idle there
    emit("ready", "\"reply\":\"ack\"");
    if (mode.equals("idle")) watchIdle();
    if (mode.equals("inflight")) {
      while (!Files.exists(go)) Thread.sleep(2);
      Throwable error = operate(2);
      if (error == null) emit("data", "\"n\":2");
      else emit("error", "\"errno\":" + q(errnoOf(error)) + ",\"message\":" + q(error.getMessage()));
    }
    Thread.sleep(Long.MAX_VALUE);
  }
}
