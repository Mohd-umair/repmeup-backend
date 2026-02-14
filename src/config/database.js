const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(
      process.env.MONGODB_URI || 'mongodb://localhost:27017/orm_development',
      {
        maxPoolSize: parseInt(process.env.MONGODB_POOL_MAX) || 50,
        minPoolSize: parseInt(process.env.MONGODB_POOL_MIN) || 10,
        maxIdleTimeMS: 30000,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        family: 4 // Use IPv4, skip trying IPv6
      }
    );

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    console.log(`📊 Database: ${conn.connection.name}`);
    console.log(`🔧 Connection Pool: ${process.env.MONGODB_POOL_MIN || 10}-${process.env.MONGODB_POOL_MAX || 50} connections`);
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;

