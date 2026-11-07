// consumer-kafka BOOTSTRAP --topic NAME --group NAME --protocol consumer|classic --process-ms N
//   --after-pause commit|rejoin [--max-s N] [--set name=value]...
//
// One member of a group of a Kafka cell: the consumer of kafka-clients 4.3.2, on Java 21. Each event
// is a JSON line with `ev` and `t`, the time on CLOCK_MONOTONIC in nanoseconds (System.nanoTime, which
// the JVM reads from it on Linux). The injector stamps each fault on the same clock.
//
// The member polls, holds the records for --process-ms, and commits the next offset of each partition
// with an explicit map. A commitSync with no map uses the positions of the partitions that the
// consumer holds. After a fence it holds none, thus that commit succeeds and tells nothing.
//
// The member sees a stop of its process as a gap in its own clock. It then does one of two things:
// - commit: it commits the map of the batch at once, before any poll.
// - rejoin: it polls until its epoch changes, and it then commits the same map. It then reads the
//   committed offsets back.
//
// The lines:
// - start: the versions, the group, the settings, and `wall`, the clock of the wall next to `t`.
//   The broker logs on the clock of the wall, thus this pair converts a log line.
// - assigned, revoked, lost: a call of the rebalance listener: `partitions`, `held` (each partition
//   after the call), `epoch` and `member`.
// - read: the records of one partition in one poll: `partition`, `first`, `last` and `count`.
// - processing: the member holds a batch from this instant.
// - pause: a gap in the clock of the member: `gap` in nanoseconds, and `in`, the part of its loop.
// - rejoined: the epoch changed after a pause: `before` and `epoch`.
// - rejoin-timeout: the epoch did not change in REJOIN_MS.
// - commit: the broker acknowledged a commit: `offsets` and `epoch`.
// - commit-fail: the error of a commit: `name`, `message`, `offsets` and `epoch`.
// - committed: the committed offsets that the member reads back: `offsets`.
// - poll-fail, read-fail: the error of a poll or of the read back.
// - done, deadline: the end of the member.
//
// A member with a rebalance listener runs the callback of a lost partition in its next poll. Thus a
// member with no poll stays fenced (ConsumerMembershipManager.java:367-374). The listener is always
// present, as in an application that keeps state for each partition.

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.TreeSet;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRebalanceListener;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.utils.AppInfoParser;

public final class ConsumerKafka {
  private static final PrintStream OUT = new PrintStream(new FileOutputStream(FileDescriptor.out), false, StandardCharsets.UTF_8);
  private static final Object LOCK = new Object();
  /** This time is the gap in the clock of the member that tells a stop, in ns. It has no source: it is far above a tick of the loop. */
  private static final long GAP_NS = 1_000_000_000L;
  /** This time is the tick of the processing, in ms. It has no source. */
  private static final long TICK_MS = 10;
  /** This time is the poll of the loop, in ms. It has no source. */
  private static final long POLL_MS = 100;
  /** This time is the poll of the wait for a new epoch, in ms. It has no source. */
  private static final long REJOIN_POLL_MS = 20;
  /** This time bounds the wait for a new epoch, in ms. It has no source: it is far above one heartbeat. */
  private static final long REJOIN_MS = 20_000;
  /** This time bounds a commit and a read back, in s. It has no source: it is far above a round trip of the group. */
  private static final long CALL_S = 20;

  private static final Set<Integer> HELD = new TreeSet<>();
  private static volatile boolean stopped = false;

  private ConsumerKafka() {}

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

  /** This function gives each value of a flag that repeats, in sequence. */
  private static List<String> flags(List<String> argv, String name) {
    List<String> out = new ArrayList<>();
    for (int at = 0; at + 1 < argv.size(); at += 1) if (argv.get(at).equals(name)) out.add(argv.get(at + 1));
    return out;
  }

  private static String numbers(Collection<Integer> values) {
    List<String> out = new ArrayList<>();
    for (int value : values) out.add(String.valueOf(value));
    return "[" + String.join(",", out) + "]";
  }

  /** This function gives the offsets of a map as a JSON object, by partition. */
  private static String offsetsOf(Map<TopicPartition, OffsetAndMetadata> offsets) {
    List<String> out = new ArrayList<>();
    for (Map.Entry<TopicPartition, OffsetAndMetadata> each : offsets.entrySet()) {
      out.add(q(String.valueOf(each.getKey().partition())) + ":" + (each.getValue() == null ? "null" : String.valueOf(each.getValue().offset())));
    }
    return "{" + String.join(",", out) + "}";
  }

  private static String failure(Throwable error) {
    return "\"name\":" + q(error.getClass().getSimpleName()) + ",\"message\":" + q(error.getMessage());
  }

  private static final class Member {
    private final KafkaConsumer<String, String> consumer;
    private final String topic;
    private final long processMs;
    private final boolean rejoin;
    private boolean rejoined = false;

    Member(KafkaConsumer<String, String> consumer, String topic, long processMs, boolean rejoin) {
      this.consumer = consumer;
      this.topic = topic;
      this.processMs = processMs;
      this.rejoin = rejoin;
    }

    private int epoch() {
      return consumer.groupMetadata().generationId();
    }

    /** This function writes the line of one call of the rebalance listener. */
    private void change(String ev, Collection<TopicPartition> partitions, boolean add) {
      List<Integer> named = new ArrayList<>();
      for (TopicPartition each : partitions) {
        named.add(each.partition());
        if (add) HELD.add(each.partition());
        else HELD.remove(each.partition());
      }
      emit(ev, "\"partitions\":" + numbers(named) + ",\"held\":" + numbers(HELD) + ",\"epoch\":" + epoch()
          + ",\"member\":" + q(consumer.groupMetadata().memberId()));
    }

    void subscribe() {
      consumer.subscribe(List.of(topic), new ConsumerRebalanceListener() {
        @Override
        public void onPartitionsRevoked(Collection<TopicPartition> partitions) {
          change("revoked", partitions, false);
        }

        @Override
        public void onPartitionsAssigned(Collection<TopicPartition> partitions) {
          change("assigned", partitions, true);
        }

        @Override
        public void onPartitionsLost(Collection<TopicPartition> partitions) {
          change("lost", partitions, false);
        }
      });
    }

    /** This function gives the records of one poll, with a line for each partition. A failure of the poll gives no records. */
    private ConsumerRecords<String, String> poll(long ms) {
      try {
        ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(ms));
        for (TopicPartition partition : records.partitions()) {
          List<ConsumerRecord<String, String>> each = records.records(partition);
          emit("read", "\"partition\":" + partition.partition() + ",\"first\":" + each.get(0).offset()
              + ",\"last\":" + each.get(each.size() - 1).offset() + ",\"count\":" + each.size());
        }
        return records;
      } catch (RuntimeException error) {
        emit("poll-fail", failure(error));
        return ConsumerRecords.empty();
      }
    }

    /** This function holds a batch for the time of the processing, and it tells if a gap came in that time. */
    private boolean process() throws InterruptedException {
      emit("processing", "");
      long begun = now();
      long last = begun;
      long end = begun + processMs * 1_000_000L;
      while (last < end) {
        Thread.sleep(TICK_MS);
        long tick = now();
        if (tick - last > GAP_NS) {
          emit("pause", tick, "\"gap\":" + (tick - last) + ",\"in\":\"process\"");
          return true;
        }
        last = tick;
      }
      return false;
    }

    private void commit(Map<TopicPartition, OffsetAndMetadata> offsets) {
      try {
        consumer.commitSync(offsets, Duration.ofSeconds(CALL_S));
        emit("commit", "\"offsets\":" + offsetsOf(offsets) + ",\"epoch\":" + epoch());
      } catch (RuntimeException error) {
        emit("commit-fail", failure(error) + ",\"offsets\":" + offsetsOf(offsets) + ",\"epoch\":" + epoch());
      }
    }

    /** This function polls until the epoch changes, commits the old map, and reads the committed offsets back. */
    private void rejoinThenCommit(Map<TopicPartition, OffsetAndMetadata> offsets) {
      int before = epoch();
      long begun = System.currentTimeMillis();
      while (epoch() == before) {
        if (System.currentTimeMillis() - begun > REJOIN_MS) {
          emit("rejoin-timeout", "\"before\":" + before);
          return;
        }
        poll(REJOIN_POLL_MS);
      }
      emit("rejoined", "\"before\":" + before + ",\"epoch\":" + epoch());
      commit(offsets);
      try {
        emit("committed", "\"offsets\":" + offsetsOf(consumer.committed(offsets.keySet(), Duration.ofSeconds(CALL_S))));
      } catch (RuntimeException error) {
        emit("read-fail", failure(error));
      }
    }

    void run() throws InterruptedException {
      long before = now();
      while (!stopped) {
        ConsumerRecords<String, String> records = poll(POLL_MS);
        long after = now();
        if (after - before > POLL_MS * 1_000_000L + GAP_NS) emit("pause", after, "\"gap\":" + (after - before) + ",\"in\":\"poll\"");
        if (records.isEmpty()) {
          before = now();
          continue;
        }
        Map<TopicPartition, OffsetAndMetadata> offsets = new LinkedHashMap<>();
        for (TopicPartition partition : records.partitions()) {
          List<ConsumerRecord<String, String>> each = records.records(partition);
          offsets.put(partition, new OffsetAndMetadata(each.get(each.size() - 1).offset() + 1));
        }
        boolean paused = process();
        if (paused && rejoin && !rejoined) {
          rejoined = true;
          rejoinThenCommit(offsets);
        } else {
          commit(offsets);
        }
        before = now();
      }
    }
  }

  public static void main(String[] args) throws Exception {
    List<String> argv = List.of(args);
    String topic = flag(argv, "--topic", null);
    String group = flag(argv, "--group", null);
    if (args.length < 1 || topic == null || group == null) {
      emit("fail", "\"why\":\"consumer-kafka BOOTSTRAP --topic NAME --group NAME\"");
      Runtime.getRuntime().halt(1);
    }
    String protocol = flag(argv, "--protocol", "consumer");
    long processMs = Long.parseLong(flag(argv, "--process-ms", "0"));
    String afterPause = flag(argv, "--after-pause", "commit");
    long max = Long.parseLong(flag(argv, "--max-s", "300")) * 1000;

    Map<String, String> settings = new LinkedHashMap<>();
    for (String each : flags(argv, "--set")) {
      int at = each.indexOf('=');
      if (at == -1) throw new IllegalArgumentException("a setting is name=value: " + each);
      settings.put(each.substring(0, at), each.substring(at + 1));
    }
    StringBuilder given = new StringBuilder("{");
    for (Map.Entry<String, String> each : settings.entrySet()) {
      if (given.length() > 1) given.append(',');
      given.append(q(each.getKey())).append(':').append(q(each.getValue()));
    }
    given.append('}');
    long t = now();
    long wall = System.currentTimeMillis();
    emit("start", t, "\"wall\":" + wall
        + ",\"client\":\"kafka-consumer\",\"driver\":" + q(AppInfoParser.getVersion())
        + ",\"java\":" + q(System.getProperty("java.version"))
        + ",\"topic\":" + q(topic) + ",\"group\":" + q(group) + ",\"protocol\":" + q(protocol)
        + ",\"process_ms\":" + processMs + ",\"after_pause\":" + q(afterPause) + ",\"settings\":" + given);

    Properties properties = new Properties();
    properties.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, args[0]);
    properties.put(ConsumerConfig.GROUP_ID_CONFIG, group);
    properties.put(ConsumerConfig.GROUP_PROTOCOL_CONFIG, protocol);
    properties.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
    properties.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
    properties.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
    properties.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
    for (Map.Entry<String, String> each : settings.entrySet()) properties.put(each.getKey(), each.getValue());

    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      // SIGTERM: the end of the member, with exit code 0, as the other clients give
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
      stopped = true;
      emit("done", "");
      Runtime.getRuntime().halt(0);
    }, "deadline");
    deadline.setDaemon(true);
    deadline.start();

    KafkaConsumer<String, String> consumer = new KafkaConsumer<>(properties);
    Member member = new Member(consumer, topic, processMs, afterPause.equals("rejoin"));
    member.subscribe();
    member.run();
  }
}
