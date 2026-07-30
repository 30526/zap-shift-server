// forcing ipv4 to resolve error
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
//_____________________________________________
require("dotenv").config();
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const express = require("express");
const cors = require("cors");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const port = process.env.PORT || 3000;

// middlewear
app.use(express.json());
app.use(cors());

// firebase admin
const admin = require("firebase-admin");

const serviceAccount = require("./zapshift-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// custom middlewear for access verification
const verifyFirebaseToken = async (req, res, next) => {
  // console.log("In the middlewear", req.headers.authorization);
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "Unauthorize access" });
  }
  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    // console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "Unauthorize access" });
  }
};

// tracking id
const crypto = require("crypto"); // Built-in Node.js module

const generateTrackingId = (prefix = "YSR") => {
  // Generate 8 random bytes (16 hex characters) safely
  const randomBytes = crypto.randomBytes(8).toString("hex").toUpperCase();

  // Format into a clean, human-readable structure (e.g., YSR-XXXX-XXXX)
  const part1 = randomBytes.slice(0, 4);
  const part2 = randomBytes.slice(4, 8);

  return `${prefix}-${part1}-${part2}`;
};

// mondo db uri
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.iphtjo4.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap_shift_db");
    const userCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");
    const trackingsCollection = db.collection("trackings");

    // custom middlewear for admin access verification
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access" });
      }
      next();
    };

    // log tracking
    const logTracking = async (trackingId, status) => {
      const log = {
        trackingId,
        status,
        detail: status.split("_").join(" "),
        createdAt: new Date(),
      };
      const result = await trackingsCollection.insertOne(log);
      return result;
    };

    // user related api
    app.get("/users", verifyFirebaseToken, async (req, res) => {
      const search = req.query.search;
      const role = req.query.role;
      const query = {};

      if (search) {
        query.$or = [
          {
            displayName: { $regex: search, $options: "i" },
          },
          { email: { $regex: search, $options: "i" } },
        ];
      }

      if (role && role !== "all") {
        query.role = role;
      }

      const cursor = userCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/users/:id", async (req, res) => {});

    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      // check if user is already exist
      const email = user.email;
      const userExist = await userCollection.findOne({ email });

      if (userExist) {
        return res.send({ message: "User already exist" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.patch(
      "/users/:id/role",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const role = req.body.role;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            role: role,
          },
        };
        const result = await userCollection.updateOne(query, updateDoc);
        res.send(result);
      },
    );

    // parcels api
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }

      const options = { sort: { createdAt: -1 } };
      const cursor = parcelsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};
      if (riderEmail) {
        query.riderEmail = riderEmail;
      }
      if (deliveryStatus !== "parcel_delivered") {
        // query.deliveryStatus = { $in: ["driver_assigned", "rider_arriving"] };
        query.deliveryStatus = { $nin: ["parcel_delivered"] };
      } else {
        query.deliveryStatus = deliveryStatus;
      }

      const cursor = parcelsCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      parcel.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcel);
      res.send(result);
    });

    app.patch("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const { riderId, riderName, riderEmail } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          deliveryStatus: "driver_assigned",
          riderId,
          riderName,
          riderEmail,
        },
      };
      const result = await parcelsCollection.updateOne(query, updateDoc);
      res.send(result);

      // update rider status
      const riderQuery = { _id: new ObjectId(riderId) };
      const updateRiderDoc = {
        $set: {
          workStatus: "In Delivery",
        },
      };
      const riderResult = await ridersCollection.updateOne(
        riderQuery,
        updateRiderDoc,
      );
      res.send(riderResult);
    });

    app.patch("/parcels/:id/status", async (req, res) => {
      const { deliveryStatus, riderId } = req.body;
      const query = { _id: new ObjectId(req.params.id) };
      const updateDoc = {
        $set: {
          deliveryStatus: deliveryStatus,
        },
      };

      if (deliveryStatus === "parcel_delivered") {
        // update rider status
        const riderQuery = { _id: new ObjectId(riderId) };
        const updateRiderDoc = {
          $set: {
            workStatus: "available",
          },
        };
        const riderResult = await ridersCollection.updateOne(
          riderQuery,
          updateRiderDoc,
        );
      }

      const result = await parcelsCollection.updateOne(query, updateDoc);

      if (deliveryStatus === "pending-pickup") {
        await ridersCollection.updateOne(
          { email: req.body.riderEmail },
          { $set: { workStatus: "available" } },
        );
      }
      res.send(result);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelsCollection.deleteOne(query);
      res.send(result);
    });

    // riders related apis
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });

    app.get("/riders", async (req, res) => {
      const { status, district, workStatus } = req.query;
      const query = {};
      if (req.query.status) {
        query.status = req.query.status;
      }
      if (district) {
        query.district = district;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const cursor = ridersCollection.find(query).sort({ createdAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    app.patch(
      "/riders/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const status = req.body.status;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            status: status,
            workStatus: "available",
          },
        };
        const result = await ridersCollection.updateOne(query, updatedDoc);
        if (status === "approved") {
          const email = req.body.email;
          const userQuery = { email };
          const updateUser = {
            $set: {
              role: "rider",
            },
          };
          const userResult = await userCollection.updateOne(
            userQuery,
            updateUser,
          );
        }
        res.send(result);
      },
    );

    // stripe payment apis
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              product_data: {
                name: paymentInfo.parcelName,
              },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancel`,
      });
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // checking if payment is already is in database to avoid duplicate entry
      const transactionId = session.payment_intent;
      const trackingId = generateTrackingId();
      const query = { transactionId: transactionId };
      const existingPayment = await paymentCollection.findOne(query);
      if (existingPayment) {
        return res.send({
          success: true,
          message: "Payment already processed",
          transactionId,
          trackingId: existingPayment.trackingId,
        });
      }

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
            trackingId: trackingId,
          },
        };
        const result = await parcelsCollection.updateOne(query, update);

        // retrive payment data to add it to payment history
        const paymentInfo = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };
        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(paymentInfo);
          logTracking;
          (trackingId, "pending_pickup");
          res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            transactionId: session.payment_intent,
            paymentInfo: resultPayment,
          });
        }
      }

      res.send({ success: false });
    });

    // payments history
    app.get("/payments", verifyFirebaseToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.customerEmail = email;

        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Forbidden access" });
        }
      }

      const cursor = paymentCollection.find(query).sort({ paidAt: -1 });
      const result = await cursor.toArray();
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
