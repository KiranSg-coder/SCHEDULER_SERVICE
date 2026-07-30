require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const sequelizeConnection = require("./config/database");

const corsOrigin =
  process.env.CORS_ORIGIN === "*"
    ? true
    : (process.env.CORS_ORIGIN || "http://localhost:5173")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
app.use(cors({ origin: corsOrigin, credentials: true }));
const webhookRoutes = require("./routes/webhook.routes");
const internalRoutes = require("./routes/internal.routes")
const { registerEventSubscriptions } = require("./startup/registerSubscriptions");
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Scheduler service running.....");
});
require('./jobs/createDailyInstances');
require('./jobs/closeDays');
require('./jobs/evaluateDays');
require('./jobs/activateRulesets');
require('./jobs/completeChallenges');
require('./jobs/sendEveningNudges');
require('./jobs/sendTodoReminders');
require('./jobs/checkSubscriptions');
require('./jobs/evaluateEnrollmentUnlocks');
require('./jobs/sendDigestReminders');


app.use('/webhook', webhookRoutes);
app.use('/internal', internalRoutes);


sequelizeConnection
  .authenticate()
  .then(() => {
    console.log("Database connection has been established successfully.");
    return sequelizeConnection.sync();
  })
  .then(() => {
    const PORT = process.env.PORT || 6013;
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      registerEventSubscriptions();
    });
  })
  .catch((err) => {
    console.error("Error occured while syncing database: ", err);
  });
module.exports = app;
