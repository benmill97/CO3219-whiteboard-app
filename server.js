require('dotenv').config();

const express = require('express');
const fileUpload = require('express-fileupload');
const { WebPubSubServiceClient } = require('@azure/web-pubsub');
const { WebPubSubEventHandler } = require('@azure/web-pubsub-express');
const Redis = require('ioredis');

const app = express();

// Initialize Redis client
const redisClient = new Redis(process.env.REDIS_URL);
redisClient.on('connect', () => console.log('Connected to Redis'));
redisClient.on('error', (err) => console.error('Redis error:', err));

// Initialize Web PubSub service client
const hubName = 'sample_draw';
let serviceClient = new WebPubSubServiceClient(process.env.Web_PubSub_ConnectionString, hubName);

let handler = new WebPubSubEventHandler(hubName, {
  path: '/eventhandler',
  handleConnect: async (req, res) => {
    res.success({
      groups: ['draw']
    });
  },
  onConnected: async (req) => {
    try {
      // Increment user count in Redis
      let users = await redisClient.incr('users');

      // Notify all clients about the updated user count
      await serviceClient.group('draw').sendToAll({
        name: 'updateUser',
        data: users
      });

      // Retrieve the current whiteboard state from Redis
      const shapes = JSON.parse(await redisClient.get('shapes') || '{}');
      const background = JSON.parse(await redisClient.get('background') || '{}');

      console.log('Retrieved shapes from Redis:', shapes);
      console.log('Retrieved background from Redis:', background);

      // Send the current state to the newly connected client
      await serviceClient.sendToUser(userId, {
        name: 'syncState',
        data: { shapes, background }
      });
    } catch (err) {
      console.error('Error in onConnected handler:', err);
    }
  },
  onDisconnected: async (req) => {
    try {
      // Decrement user count in Redis
      let users = await redisClient.decr('users');
      if (users < 0) {
        users = 0;
        await redisClient.set('users', 0); // Ensure no negative values in Redis
      }

      // Notify all clients about the updated user count
      await serviceClient.group('draw').sendToAll({
        name: 'updateUser',
        data: users
      });
    } catch (err) {
      console.error('Error in onDisconnected handler:', err);
    }
  },
  handleUserEvent: async (req, res) => {
    try {
      let message = req.data;
      switch (message.name) {
        case 'addShape': {
          let [id, shape] = message.data;
          const shapes = JSON.parse(await redisClient.get('shapes') || '{}');
          shapes[id] = shape;
          await redisClient.set('shapes', JSON.stringify(shapes));
          break;
        }
        case 'removeShape': {
          let id = message.data;
          const shapes = JSON.parse(await redisClient.get('shapes') || '{}');
          delete shapes[id];
          await redisClient.set('shapes', JSON.stringify(shapes));
          break;
        }
        case 'clear': {
          await redisClient.del('shapes');
          await redisClient.del('background');
          break;
        }
      }
      res.success();
    } catch (err) {
      console.error('Error in handleUserEvent:', err);
      res.fail();
    }
  }
});

app.use(fileUpload());
app.use(handler.getMiddleware());

app
  .get('/negotiate', async (req, res) => {
    try {
      let token = await serviceClient.getClientAccessToken({
        roles: ['webpubsub.sendToGroup.draw']
      });
      res.json({
        url: token.url
      });
    } catch (err) {
      console.error('Error in negotiate endpoint:', err);
      res.status(500).send('Failed to negotiate.');
    }
  })
  .get('/diagram', async (req, res) => {
    try {
      const shapes = JSON.parse(await redisClient.get('shapes') || '{}');
      const background = await redisClient.get('background');
      res.json({
        shapes,
        background
      });
    } catch (err) {
      console.error('Error in diagram endpoint:', err);
      res.status(500).send('Failed to retrieve diagram data.');
    }
  })
  .post('/background/upload', async (req, res) => {
    try {
      const background = {
        id: Math.random().toString(36).substr(2, 8),
        data: req.files['file'].data,
        contentType: req.files['file'].mimetype
      };
      await redisClient.set('background', JSON.stringify(background));
      await serviceClient.sendToAll({
        name: 'updateBackground',
        data: background.id
      });
      res.end();
    } catch (err) {
      console.error('Error in background upload endpoint:', err);
      res.status(500).send('Failed to upload background.');
    }
  })
  .get('/background/:id', async (req, res) => {
    try {
      const background = JSON.parse(await redisClient.get('background') || '{}');
      if (background.id === req.params.id) {
        res.type(background.contentType);
        res.send(Buffer.from(background.data.data)); // Ensure buffer for binary data
      } else res.status(404).end();
    } catch (err) {
      console.error('Error in background retrieval endpoint:', err);
      res.status(500).send('Failed to retrieve background.');
    }
  });

app.use(express.static('dist'));
app.listen(8080, () => console.log('app started'));
