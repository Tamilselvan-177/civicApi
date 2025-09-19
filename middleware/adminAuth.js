const jwt = require("jsonwebtoken");

function roleAuth(allowedRoles = []) {
  return (req, res, next) => {
    const token = req.header("Authorization");
    console.log("🔑 Token received:", token ? "Present" : "Missing");
    console.log("🔑 Allowed roles:", allowedRoles);
    
    if (!token) {
      return res.status(401).json({ msg: "No token, authorization denied" });
    }

    try {
      const decoded = jwt.verify(
        token.replace("Bearer ", ""),
        process.env.JWT_SECRET
      );
      
      console.log("🔑 Decoded token:", decoded);
      console.log("🔑 User role:", decoded.role);
      console.log("🔑 Role check:", allowedRoles.includes(decoded.role));

      if (!allowedRoles.includes(decoded.role)) {
        console.log("❌ Access denied: Role", decoded.role, "not in", allowedRoles);
        return res.status(403).json({ msg: "Access denied: Insufficient role" });
      }

      req.user = decoded; // user can be admin, superadmin, department
      console.log("✅ Access granted for role:", decoded.role);
      next();
    } catch (err) {
      console.log("❌ Token validation error:", err.message);
      res.status(400).json({ msg: "Token is not valid" });
    }
  };
}

module.exports = roleAuth;
