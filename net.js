const async = require('async');
const Node = require('./node');
const assert = require('assert');
const { Barrier, DeasyncObject } = require('./utils');

let verbose = process.env.V === '1';

const BitcoinNet = function(path, cfgprefix, portstart, rpcportstart) {
    this.path = path;
    this.cfgprefix = cfgprefix;
    this.nextport = portstart;
    this.nextrpcport = rpcportstart;
    this.nodes = [];
};

BitcoinNet.setVerbose = (v) => {
    Node.setVerbose(v);
    verbose = v;
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
            (err) => cb ? cb(err, batch) : null
        );
    },
    waitForNodes(nodes, timeout, cb) {
        if (!cb) { cb = timeout; timeout = 10000; }
        assert(typeof(cb) === 'function');
        async.eachSeries(
            nodes,
            (node, asyncCallback) => node.waitUntilReady(timeout, asyncCallback),
            cb
        );
    },
    connectNodes(nodes, cb) {
        assert(typeof(cb) === 'function');
        let rem = nodes;
        let aggregated = [];
        async.each(
            nodes,
            (node, eachCallback) => {
                assert(node.port === rem[0].port);
                rem = rem.slice(1);
                if (rem.length > 0) {
                    node.connect(rem, (err, results) => {
                        if (!err) aggregated = aggregated.concat(results);
                        eachCallback(err);
                    });
                } else eachCallback(null);
            },
            (err) => cb ? cb(err, aggregated) : null
        );
    },
    /**
     * Disconnect all nodes in nodegroupA from all the nodes in nodegroupB,
     * so that the two groups are completely isolated from each other.
     * Two disconnected groups will not share peer info, such as mem pools,
     * new blocks, and so on.
     */
    disconnectGroups(nodegroupA, nodegroupB, cb) {
        async.each(
            nodegroupA,
            (a, eachCallback) => {
                const connections = a.getConnected(nodegroupB);
                a.disconnect(connections, eachCallback);
            },
            (err) => {
                if (err) return cb(err);
                async.each(
                    nodegroupB,
                    (b, eachCallback) => {
                        const connections = b.getConnected(nodegroupA);
                        b.disconnect(connections, eachCallback);
                    },
                    cb
                );
            }
        );
    },
    /**
     * Partition the list of nodes in nodelist into the given number of 
     * groups (default 2). Each group will be connected to each other, but
     * disconnected from all other nodes in the other groups. 
     * Existing, external connections remain untouched.
     *
     * Once finished, cb(err, nodeGroups) is called, where nodeGroups is an
     * array of arrays, each corresponding to one group.
     */
    partition(nodelist, groups, designations, cb) {
        if (!cb) { cb = designations; designations = null; }
        assert(typeof(cb) === 'function');
        const skip = {};
        let ngm = {};
        let iter = 0;
        let space = 0;
        if (groups > nodelist.length) groups = nodelist.length;
        const nodesPerPartition = nodelist.length / groups;
        if (designations) {
            // {grpidx: [n, n, ...], ...}
            for (const grpidx of Object.keys(designations)) {
                ngm[grpidx] = designations[grpidx];
                for (const n of designations[grpidx]) {
                    skip[n.stringid()] = 1;
                    n.net_tmp_ng = grpidx;
                }
            }
        }
        let p = ngm[iter] = ngm[iter] || [];
        for (let i = 0; i < nodelist.length; i++) {
            if (space >= nodesPerPartition) {
                iter++;
                p = ngm[iter] = ngm[iter] || [];
                space += p.length - nodesPerPartition;
            }
            const n = nodelist[i];
            if (skip[n.stringid()]) continue;
            p.push(n);
            n.net_tmp_ng = iter;
            space += 1;
        }
        const nodeGroups = Object.values(ngm);

        // disconnect everyone from everyone who is not in the same group
        const b = new Barrier();
        for (let i = 0; i < nodelist.length; i++) {
            const n = nodelist[i];
            for (let j = i + 1; j < nodelist.length; j++) {
                const m = nodelist[j];
                if (n.net_tmp_ng !== m.net_tmp_ng) {
                    if (n.isConnected(m)) n.disconnect(m, b.tick());
                    if (m.isConnected(n)) m.disconnect(n, b.tick());
                }
            }
        }
        
        b.wait((err) => {
            if (err) return cb(err);
            // connect each group individually
            b.clear();
            for (const nodeGroup of nodeGroups) {
                this.connectNodes(nodeGroup, b.tick());
            }
            b.wait((err) => {
                if (err) return cb ? cb(err) : null;
                if (cb) cb(err, nodeGroups);
            });
        });
    },
    /**
     * Merge the nodes in the node list. This is an alias for 
     * connectNodes(nodelist, cb)
     */
    merge(nodelist, cb) {
        assert(typeof(cb) === 'function');
        this.connectNodes(nodelist, cb);
    },
    /**
     * Wait for the nodes in the given nodelist to reach the same state as each
     * other. The nodes must be connected. This is tested, and an assertion
     * thrown if it is not the case.
     */
    sync(nodelist, timeout, cb) {
        if (!cb) { cb = timeout; timeout = 10000; }
        assert(typeof(cb) === 'function');
        let prev = null;
        for (const node of nodelist) {
            if (prev) assert(node.isConnected(prev, true));
            prev = node;
        }
        prev = null;
        async.eachSeries(
            nodelist,
            (node, seriesCallback) => {
                if (prev) {
                    node.sync(prev, timeout, (err) => {
                        prev = node;
                        seriesCallback(err);
                    });
                } else {
                    prev = node;
                    seriesCallback(null);
                }
            },
            (err) => {
                cb(err);
            }
        )
    },
};

DeasyncObject(BitcoinNet, [
]);

module.exports = BitcoinNet;
