// admin-kafka BOOTSTRAP create TOPIC MIN_INSYNC BROKER,BROKER,...
// admin-kafka BOOTSTRAP view [TOPIC]
// admin-kafka BOOTSTRAP holds TOPIC
//
// The admin of a Kafka lab, on the Admin client and the consumer of kafka-clients 4.3.2. Each command
// prints one JSON line. An error ends the command with exit code 1, and the lab then reads the error.
// - create: a topic with one partition, its replicas on the brokers in sequence, and its setting of
//   min.insync.replicas. The first broker is the first leader.
// - view: the ids of the brokers that are not fenced. With a topic, also the leader, the in-sync
//   replicas and the replicas of its partition. The controller lists only brokers that are not fenced.
// - holds: the value of each record of the partition from its first offset to its high watermark,
//   one entry for each copy.

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.admin.TopicDescription;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.Node;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.TopicPartitionInfo;
import org.apache.kafka.common.serialization.StringDeserializer;

public final class AdminKafka {
  /** This time bounds each call of the admin, in ms. It has no source: a lab repeats a view that fails. */
  private static final String CALL_MS = "10000";
  /** This time bounds a whole read of the partition, in ms. It has no source: it is far above the read of a run. */
  private static final long READ_MS = 60_000;

  private AdminKafka() {}

  private static Admin adminOf(String bootstrap) {
    Properties properties = new Properties();
    properties.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap);
    properties.put(AdminClientConfig.REQUEST_TIMEOUT_MS_CONFIG, CALL_MS);
    properties.put(AdminClientConfig.DEFAULT_API_TIMEOUT_MS_CONFIG, CALL_MS);
    return Admin.create(properties);
  }

  private static String idsOf(List<Node> nodes) {
    List<String> ids = new ArrayList<>();
    for (Node node : nodes) ids.add(String.valueOf(node.id()));
    return "[" + String.join(",", ids) + "]";
  }

  private static void create(String bootstrap, String topic, String minInsync, String brokers) throws Exception {
    List<Integer> replicas = new ArrayList<>();
    for (String id : brokers.split(",")) replicas.add(Integer.valueOf(id));
    try (Admin admin = adminOf(bootstrap)) {
      NewTopic created = new NewTopic(topic, Map.of(0, replicas)).configs(Map.of("min.insync.replicas", minInsync));
      admin.createTopics(List.of(created)).all().get();
    }
    System.out.println("{\"ok\":true}");
  }

  private static void view(String bootstrap, String topic) throws Exception {
    try (Admin admin = adminOf(bootstrap)) {
      String brokers = idsOf(new ArrayList<>(admin.describeCluster().nodes().get()));
      if (topic == null) {
        System.out.println("{\"brokers\":" + brokers + "}");
        return;
      }
      TopicDescription described = admin.describeTopics(List.of(topic)).allTopicNames().get().get(topic);
      TopicPartitionInfo partition = described.partitions().get(0);
      System.out.println("{\"brokers\":" + brokers
          + ",\"leader\":" + (partition.leader() == null ? "null" : String.valueOf(partition.leader().id()))
          + ",\"isr\":" + idsOf(partition.isr())
          + ",\"replicas\":" + idsOf(partition.replicas()) + "}");
    }
  }

  private static void holds(String bootstrap, String topic) {
    Properties properties = new Properties();
    properties.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap);
    properties.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
    properties.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
    properties.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
    properties.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
    TopicPartition partition = new TopicPartition(topic, 0);
    List<String> held = new ArrayList<>();
    try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(properties)) {
      consumer.assign(List.of(partition));
      consumer.seekToBeginning(List.of(partition));
      long end = consumer.endOffsets(List.of(partition)).get(partition);
      long begun = System.currentTimeMillis();
      while (consumer.position(partition) < end) {
        if (System.currentTimeMillis() - begun > READ_MS) throw new IllegalStateException("the read stopped at offset " + consumer.position(partition) + " of " + end);
        for (ConsumerRecord<String, String> record : consumer.poll(Duration.ofMillis(500))) held.add(record.value());
      }
      System.out.println("{\"held\":[" + String.join(",", held) + "],\"end\":" + end + "}");
    }
  }

  public static void main(String[] args) throws Exception {
    if (args.length < 2) {
      System.err.println("admin-kafka BOOTSTRAP create|view|holds ...");
      System.exit(1);
    }
    switch (args[1]) {
      case "create" -> create(args[0], args[2], args[3], args[4]);
      case "view" -> view(args[0], args.length > 2 ? args[2] : null);
      case "holds" -> holds(args[0], args[2]);
      default -> {
        System.err.println("no command " + args[1]);
        System.exit(1);
      }
    }
    System.exit(0);
  }
}
