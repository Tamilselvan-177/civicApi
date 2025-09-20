const jwt = require("jsonwebtoken");

const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4Y2NlZDk4MDRjNjNmMjY0ZDIxODZiNyIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc1ODI2MDc1MCwiZXhwIjoxNzg5ODE4MzUwfQ.UQG-hMlmDU5ZtiURjT2d7Hywq80ORtTtfrUmNndC-t4";

try {
  const decoded = jwt.verify(token, "secretkey");
  console.log("Decoded token:", decoded);
  console.log("Role in token:", decoded.role);
  console.log("Role type:", typeof decoded.role);
} catch (error) {
  console.error("Error decoding token:", error.message);
}

