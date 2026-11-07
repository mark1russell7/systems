// admin-kafka BOOTSTRAP create TOPIC MIN_INSYNC BROKER,BROKER,... [PARTITIONS]
// admin-kafka BOOTSTRAP view [TOPIC]
// admin-kafka BOOTSTRAP holds TOPIC
// admin-kafka BOOTSTRAP fill TOPIC PARTITIONS COUNT
//
// The admin of a Kafka lab, on the Admin client, the consumer and the producer of kafka-clients 4.3.2.
// Each command prints one JSON line. An error ends the command with exit code 1, and the lab then
// reads the error.
// - create: a topic with one partition or more, its replicas on the brokers in sequence, and its
//   setting of min.insync.replicas. The first broker is the first leader of partition 0. Each next
//   partition starts its replicas one broker later.
// - fill: COUNT records in each partition, each acknowledged by each in-sync replica.
// - view: the ids of the brokers that are not fenced. With a topic, also the leader, the in-sync
//   replicas and the replicas of its partition. The controller lists only brokers that are not fenced.
// - holds: the value of each record of the partition from its first offset to its high watermark,
//   one entry for each copy.

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.Future;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.admin.TopicDescription;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.clients.producer.RecordMetadata;
import org.apache.kafka.common.Node;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.TopicPartitionInfo;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;

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

  private static void create(String bootstrap, String topic, String minInsync, String brokers, int partitions) throws Exception {
    List<Integer> replicas = new ArrayList<>();
    for (String id : brokers.split(",")) replicas.add(Integer.valueOf(id));
    Map<Integer, List<Integer>> assignments = new HashMap<>();
    for (int partition = 0; partition < partitions; partition += 1) {
      assignments.put(partition, new ArrayList<>(replicas));
      Collections.rotate(replicas, -1);
    }
    try (Admin admin = adminOf(bootstrap)) {
      NewTopic created = new NewTopic(topic, assignments).configs(Map.of("min.insync.replicas", minInsync));
      admin.createTopics(List.of(created)).all().get();
    }
    System.out.println("{\"ok\":true}");
  }

  private static void fill(String bootstrap, String topic, int partitions, int count) throws Exception {
    Properties properties = new Properties();
    properties.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap);
    properties.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
    properties.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
    properties.put(ProducerConfig.ACKS_CONFIG, "all");
    try (KafkaProducer<String, String> producer = new KafkaProducer<>(properties)) {
      List<Future<RecordMetadata>> sent = new ArrayList<>();
      for (int partition = 0; partition < partitions; partition += 1) {
        for (int at = 0; at < count; at += 1) sent.add(producer.send(new ProducerRecord<>(topic, partition, null, String.valueOf(at))));
      }
      producer.flush();
      for (Future<RecordMetadata> each : sent) each.get();
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
      System.err.println("admin-kafka BOOTSTRAP create|view|holds|fill ...");
      System.exit(1);
    }
    switch (args[1]) {
      case "create" -> create(args[0], args[2], args[3], args[4], args.length > 5 ? Integer.parseInt(args[5]) : 1);
      case "view" -> view(args[0], args.length > 2 ? args[2] : null);
      case "holds" -> holds(args[0], args[2]);
      case "fill" -> fill(args[0], args[2], Integer.parseInt(args[3]), Integer.parseInt(args[4]));
      default -> {
        System.err.println("no command " + args[1]);
        System.exit(1);
      }
    }
    System.exit(0);
  }
}
