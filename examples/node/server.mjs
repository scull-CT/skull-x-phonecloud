import { createServer } from 'node:http';

createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    return response.end(JSON.stringify({ healthy: true }));
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PhoneCloud sample</title><main><h1>Running on Skull X PhoneCloud</h1><p>The Node.js sample is online.</p></main></html>');
}).listen(Number(process.env.PORT || 9000), process.env.HOST || '127.0.0.1');
