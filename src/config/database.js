const { Sequelize } = require("sequelize");

const sequelize = new Sequelize(
  process.env.DB_NAME || "SCHEDULER_SERVICE",
  process.env.DB_USER || "auth",
  process.env.DB_PASSWORD || "1234",
  {
  host: process.env.DB_HOST || "DESKTOP-C1F49GD",
  dialect: "mssql",
  logging: false,
  dialectOptions: {
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
  },
  pool: {
    max: 5,
    min: 0,
    idle: 30000,
  },
  }
);

module.exports = sequelize;
