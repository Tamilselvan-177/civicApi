const axios = require('axios');

async function testAPI() {
  try {
    // First, login to get a token
    console.log('🔑 Logging in...');
    const loginResponse = await axios.post('http://localhost:5000/api/admin/login', {
      email: 'admin@test.com',
      password: 'admin123'
    });
    
    const token = loginResponse.data.token;
    console.log('✅ Login successful, token received');
    
    // Test the admin posts endpoint
    console.log('📊 Testing admin posts endpoint...');
    const postsResponse = await axios.get('http://localhost:5000/api/admin/posts/all', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    console.log('✅ Admin posts endpoint successful');
    console.log('📊 Number of posts:', postsResponse.data.length);
    console.log('📊 First post:', postsResponse.data[0]);
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    if (error.response?.status === 403) {
      console.log('🔍 This is a 403 error - role permission issue');
    }
  }
}

testAPI();
