const async = require('async');
const Node = require('./node');

const BitcoinNet = function(path, cfgprefix, portstart, rpcportstart) {
    this.path = path;
    this.cfgprefix = cfgprefix;
    this.nextport = portstart;
    this.nextrpcport = rpcportstart;
    this.nodes = [];
};

BitcoinNet.prototype = {
    shutdown(cb) {
        for (const node of this.nodes) {
            node.stop();
        }
        let running = 1;
        const blk = () => {
            running = 0;
            for (const node of this.nodes) running += !!node.running;
            if (running > 0) setTimeout(blk, 200); else cb();
        };
        blk();
    },
    launchBatch(count = 1, cb) {
        const batch = [];
        for (let i = 0; i < count; i++) {
            const node = new Node(this.path, `${this.cfgprefix}/${this.nextport}`, '127.0.0.1', this.nextport, this.nextrpcport);
            this.nodes.push(node);
            batch.push(node);
            this.nextport += 10;
            this.nextrpcport += 10;
        }
        async.eachSeries(batch,
            (node, asyncCallback) => node.start(asyncCallback),
            (err) => cb(err, batch)
        );
    },
    waitForNodes(nodes, timeout, cb) {
        if (!cb) { cb = timeout; timeout = 10000; }
        async.eachSeries(
            nodes,
            (node, asyncCallback) => node.waitUntilReady(timeout, asyncCallback),
            cb
        );
    },
    connectNodes(nodes, cb) {
        const connector = nodes[0];
        const connectees = nodes.slice(1);
        connector.connect(connectees, cb);
    },
    disconnectGroups(nodegroupA, nodegroupB) {
        for (const a of nodegroupA) {
            const connections = a.getConnected(nodegroupB);
            a.disconnect(connections);
        }
        for (const b of nodegroupB) {
            const connections = b.getConnected(nodegroupA);
            b.disconnect(connections);
        }
    },
};

module.exports = BitcoinNet;
