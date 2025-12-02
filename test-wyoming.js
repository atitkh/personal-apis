const net = require('net');

const client = new net.Socket();
const HOST = 'voltex-ubuntu'; // Wyoming server hostname
const PORT = 10200; // Piper port

console.log(`Attempting to connect to ${HOST}:${PORT}...`);

client.connect(PORT, HOST, () => {
  console.log('Connected to Wyoming server');
  
  // Try different message types
  const messages = [
    { type: 'DESCRIBE', id: 'test-client' },
    { type: 'INFO', id: 'test-client' },
    { type: 'info' },
    { type: 'describe' }
  ];
  
  messages.forEach((msg, index) => {
    setTimeout(() => {
      console.log(`Sending message ${index + 1}:`, JSON.stringify(msg));
      client.write(JSON.stringify(msg) + '\n');
    }, index * 1000);
  });
  
  // Auto-close after 10 seconds
  setTimeout(() => {
    console.log('Closing connection...');
    client.destroy();
  }, 10000);
});

client.on('data', (data) => {
  // Handle incoming data (e.g., service info)
  console.log('Received: ' + data.toString());
});

client.on('close', () => {
  console.log('Connection closed');
  process.exit(0);
});

client.on('error', (err) => {
  console.error('Connection error: ', err.message);
  process.exit(1);
});