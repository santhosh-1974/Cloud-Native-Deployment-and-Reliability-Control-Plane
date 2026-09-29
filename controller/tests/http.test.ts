import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import request from 'supertest';
import type { Express } from 'express';
let app: Express;
before(async () => { process.env.NODE_ENV = 'test'; ({ app } = await import('../src/app')); });
void describe('HTTP foundation', () => {
  void it('returns healthy JSON with HTTP 200', async () => { const response = await request(app).get('/health'); assert.equal(response.status, 200); assert.match(response.headers['content-type'] ?? '', /application\/json/); assert.deepEqual(response.body, { status: 'ok' }); });
  void it('returns a request ID and reuses a valid supplied UUID', async () => { const supplied = '4c4f32c6-9a46-4b84-86d4-61aab4cf2969'; const response = await request(app).get('/health').set('x-request-id', supplied); assert.equal(response.headers['x-request-id'], supplied); });
  void it('generates an ID for an invalid supplied value', async () => { const response = await request(app).get('/health').set('x-request-id', 'bad id'); assert.match(response.headers['x-request-id'] ?? '', /^[0-9a-f-]{36}$/i); });
  void it('serializes expected errors', async () => { const response = await request(app).get('/__test/expected-error'); assert.equal(response.status, 400); assert.deepEqual(response.body.error, { code: 'INVALID_REQUEST', message: 'Invalid request' }); assert.ok(response.body.requestId); });
  void it('does not return unexpected error or stack details', async () => { const response = await request(app).get('/__test/unexpected-error'); assert.equal(response.status, 500); assert.equal(JSON.stringify(response.body).includes('private stack detail'), false); assert.equal(JSON.stringify(response.body).includes(' at '), false); });
});
