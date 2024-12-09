require("dotenv").config();

const express = require("express");
const fileUpload = require("express-fileupload");
const { WebPubSubServiceClient } = require("@azure/web-pubsub");
const { WebPubSubEventHandler } = require("@azure/web-pubsub-express");
const Redis = require("ioredis");

const app = express();

// Initialize Redis client
const redisClient = new Redis(process.env.REDIS_URL);
redisClient.on("connect", () => console.log("Connected to Redis"));
redisClient.on("error", (err) => console.error("Redis error:", err));

// Initialize Web PubSub service client
const hubName = "sample_draw";
const serviceClient = new WebPubSubServiceClient(
  process.env.Web_PubSub_ConnectionString,
  hubName
);

// Redis key for storing recent broadcast events
const EVENT_QUEUE_KEY = "eventQueue";

// Helper function to replay missed events for newly connected users
const replayMissedEvents = async (userId) => {
  const events = await redisClient.lrange(EVENT_QUEUE_KEY, 0, -1); // Retrieve recent events
  for (const event of events) {
    await serviceClient.sendToUser(userId, JSON.parse(event)); // Send each event to the user
  }
};

// Web PubSub Event Handler
const handler = new WebPubSubEventHandler(hubName, {
  path: "/eventhandler",
  handleConnect: async (req, res) => {
    res.success({ groups: ["draw"] });
  },
  onConnected: async (req) => {
    try {
      const userId = req.context.userId;

      // Increment user count and notify all clients
      const users = await redisClient.incr("users");
      await serviceClient
        .group("draw")
        .sendToAll({ name: "updateUser", data: users });

      // Send the full whiteboard state to the newly connected user
      const shapes = JSON.parse((await redisClient.get("shapes")) || "{}");
      const background = JSON.parse(
        (await redisClient.get("background")) || "{}"
      );
      await serviceClient.sendToUser(userId, {
        name: "syncState",
        data: { shapes, background },
      });

      // Replay missed events to bring the user up to date
      await replayMissedEvents(userId);
    } catch (err) {
      console.error("Error in onConnected handler:", err);
    }
  },
  onDisconnected: async (req) => {
    try {
      // Decrement user count and notify all clients
      const users = Math.max(0, await redisClient.decr("users"));
      await redisClient.set("users", users); // Ensure no negative values
      await serviceClient
        .group("draw")
        .sendToAll({ name: "updateUser", data: users });
    } catch (err) {
      console.error("Error in onDisconnected handler:", err);
    }
  },
  handleUserEvent: async (req, res) => {
    try {
      const message = req.data;

      // Store the event in Redis for replay
      await redisClient.lpush(EVENT_QUEUE_KEY, JSON.stringify(message));
      await redisClient.ltrim(EVENT_QUEUE_KEY, 0, 99); // Keep only the last 100 events

      // Update shapes or background state in Redis based on the event
      if (message.name === "addShape") {
        const [id, shape] = message.data;
        const shapes = JSON.parse((await redisClient.get("shapes")) || "{}");
        shapes[id] = shape;
        await redisClient.set("shapes", JSON.stringify(shapes));
      } else if (message.name === "removeShape") {
        const id = message.data;
        const shapes = JSON.parse((await redisClient.get("shapes")) || "{}");
        delete shapes[id];
        await redisClient.set("shapes", JSON.stringify(shapes));
      } else if (message.name === "clear") {
        await redisClient.del("shapes");
        await redisClient.del("background");
      }

      // Broadcast the event to all connected clients
      await serviceClient.group("draw").sendToAll(message);

      res.success();
    } catch (err) {
      console.error("Error in handleUserEvent:", err);
      res.fail();
    }
  },
});

app.use(fileUpload());
app.use(handler.getMiddleware());

// Routes for negotiating connections and managing diagrams
app
  .get("/negotiate", async (req, res) => {
    try {
      const token = await serviceClient.getClientAccessToken({
        roles: ["webpubsub.sendToGroup.draw"],
      });
      res.json({ url: token.url });
    } catch (err) {
      console.error("Failed to negotiate:", err);
      res.status(500).send("Failed to negotiate.");
    }
  })
  .get("/diagram", async (req, res) => {
    try {
      const shapes = JSON.parse((await redisClient.get("shapes")) || "{}");
      const background = JSON.parse(
        (await redisClient.get("background")) || "{}"
      );
      res.json({ shapes, background });
    } catch (err) {
      console.error("Failed to retrieve diagram:", err);
      res.status(500).send("Failed to retrieve diagram.");
    }
  })
  .post("/background/upload", async (req, res) => {
    try {
      const background = {
        id: Math.random().toString(36).substr(2, 8),
        data: req.files.file.data,
        contentType: req.files.file.mimetype,
      };
      await redisClient.set("background", JSON.stringify(background));
      await serviceClient
        .group("draw")
        .sendToAll({ name: "updateBackground", data: background.id });
      res.end();
    } catch (err) {
      console.error("Failed to upload background:", err);
      res.status(500).send("Failed to upload background.");
    }
  })
  .get("/background/:id", async (req, res) => {
    try {
      const background = JSON.parse(
        (await redisClient.get("background")) || "{}"
      );
      if (background.id === req.params.id) {
        res.type(background.contentType);
        res.send(Buffer.from(background.data.data)); // Ensure buffer for binary data
      } else {
        res.status(404).end();
      }
    } catch (err) {
      console.error("Failed to retrieve background:", err);
      res.status(500).send("Failed to retrieve background.");
    }
  });

app.use(express.static("dist"));
app.listen(8080, () => console.log("Server started on port 8080"));
