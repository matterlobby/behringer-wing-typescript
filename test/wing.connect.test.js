const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyCalls = [];
    this.ended = false;
    this.noDelay = undefined;
    this.writes = [];
  }

  setNoDelay(value) {
    this.noDelay = value;
  }

  write(chunk, callback) {
    this.writes.push(Buffer.from(chunk));
    callback?.();
    return true;
  }

  end(callback) {
    this.ended = true;
    callback?.();
    return this;
  }

  destroy(error) {
    this.destroyCalls.push(error);
    this.emit('close');
    return this;
  }
}

async function withWingStub(createConnection, run) {
  const originalCreateConnection = net.createConnection;
  const wingModulePath = require.resolve('../dist/wing.js');
  net.createConnection = createConnection;
  delete require.cache[wingModulePath];

  try {
    const { Wing } = require('../dist/wing.js');
    await run(Wing);
  } finally {
    net.createConnection = originalCreateConnection;
    delete require.cache[wingModulePath];
  }
}

test('connect resolves before timeout and sends handshake bytes', async () => {
  const socket = new FakeSocket();

  await withWingStub(({ host, port }) => {
    assert.equal(host, '192.0.2.10');
    assert.equal(port, 2222);
    setImmediate(() => socket.emit('connect'));
    return socket;
  }, async (Wing) => {
    const wing = await Wing.connect('192.0.2.10', { connectTimeout: 50 });

    assert.equal(socket.noDelay, true);
    assert.deepEqual(socket.writes, [Buffer.from([0xdf, 0xd1])]);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(socket.destroyCalls.length, 0);

    await wing.close();
  });
});

test('connect rejects with a timeout error and destroys the socket', async () => {
  const socket = new FakeSocket();

  await withWingStub(() => socket, async (Wing) => {
    await assert.rejects(
      Wing.connect('198.51.100.23', { connectTimeout: 20 }),
      (err) => {
        assert.equal(err.code, 'WING_CONNECT_TIMEOUT');
        assert.match(err.message, /198\.51\.100\.23:2222/);
        assert.match(err.message, /20ms/);
        return true;
      },
    );

    assert.equal(socket.destroyCalls.length, 1);
    assert.equal(socket.listenerCount('connect'), 0);
    assert.equal(socket.listenerCount('error'), 0);
  });
});

test('connect rejects on socket error before the timeout and clears the timeout path', async () => {
  const socket = new FakeSocket();
  const failure = new Error('ECONNREFUSED');

  await withWingStub(() => {
    setTimeout(() => socket.emit('error', failure), 10);
    return socket;
  }, async (Wing) => {
    await assert.rejects(Wing.connect('203.0.113.7', { connectTimeout: 50 }), failure);

    assert.equal(socket.destroyCalls.length, 1);

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(socket.destroyCalls.length, 1);
    assert.equal(socket.listenerCount('connect'), 0);
    assert.equal(socket.listenerCount('error'), 0);
  });
});

test('connect removes completion listeners after success to prevent double-settle races', async () => {
  const socket = new FakeSocket();

  await withWingStub(() => {
    setImmediate(() => socket.emit('connect'));
    return socket;
  }, async (Wing) => {
    const wing = await Wing.connect('203.0.113.42', { connectTimeout: 20 });

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(socket.destroyCalls.length, 0);
    assert.equal(socket.listenerCount('connect'), 0);

    await wing.close();
  });
});
