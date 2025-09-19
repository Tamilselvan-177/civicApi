const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("./models/User");
require("dotenv").config();

async function createTestUser() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    // Check if admin user already exists
    const existingAdmin = await User.findOne({ email: "admin@test.com" });
    if (existingAdmin) {
      console.log("✅ Admin user already exists");
      return;
    }

    // Create admin user
    const hashedPassword = await bcrypt.hash("admin123", 10);
    const adminUser = new User({
      username: "admin",
      email: "admin@test.com",
      password: hashedPassword,
      role: "admin",
      isVerified: true
    });

    await adminUser.save();
    console.log("✅ Admin user created successfully");
    console.log("Email: admin@test.com");
    console.log("Password: admin123");
    console.log("Role: admin");

    // Create superadmin user
    const existingSuperAdmin = await User.findOne({ email: "superadmin@test.com" });
    if (!existingSuperAdmin) {
      const superAdminUser = new User({
        username: "superadmin",
        email: "superadmin@test.com",
        password: hashedPassword,
        role: "superadmin",
        isVerified: true
      });

      await superAdminUser.save();
      console.log("✅ Superadmin user created successfully");
      console.log("Email: superadmin@test.com");
      console.log("Password: admin123");
      console.log("Role: superadmin");
    }

    // Create department user
    const existingDept = await User.findOne({ email: "department@test.com" });
    if (!existingDept) {
      const deptUser = new User({
        username: "department",
        email: "department@test.com",
        password: hashedPassword,
        role: "department",
        isVerified: true
      });

      await deptUser.save();
      console.log("✅ Department user created successfully");
      console.log("Email: department@test.com");
      console.log("Password: admin123");
      console.log("Role: department");
    }

  } catch (error) {
    console.error("❌ Error creating test user:", error);
  } finally {
    await mongoose.disconnect();
    console.log("✅ Disconnected from MongoDB");
  }
}

createTestUser();
