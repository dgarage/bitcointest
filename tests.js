/* global describe it */
/* eslint import/no-extraneous-dependencies: 0 */
/* eslint no-console: 0 */
/* eslint no-unused-expressions: 0 */

const chai = require('chai');
const { BitcoinGraph, Node, BitcoinNet, Transaction } = require('./index');
const async = require('async');

const expect = chai.expect;
let net;
let graph;
let nodes;  // alias for grp1
let node;   // alias for nodes[0] == grp1[0]
let node2;  // alias for nodes[1] == grp1[1]
let grp1;   // node 0, 1 [net node 2, 3]
let grp2;   // node 2, 3 [net node 0, 1]

describe('bitcoind', () => {
  it('can be found', (done) => {
    const which = require('which');
    which('bitcoind', (whichErr, whichPath) => {
      const bitcoinPath =
        process.env.BITCOIN_PATH ||
        (!whichErr && whichPath
          ? whichPath.substr(0, whichPath.length - 8)
          : '../bitcoin/src/');
       net = new BitcoinNet(bitcoinPath, '/tmp/bitcointest/', 22001, 22002);
       graph = new BitcoinGraph(net);
       expect(net).to.not.be.null;
       done();
    });
  });
});

describe('BitcoinNet', () => {
  it('launches nodes', (done) => {
    const n = net.launchBatchS(2);
    expect(n.length).to.equal(2);
    grp2 = n;
    const n2 = net.launchBatchS(2);
    expect(n2.length).to.equal(2);
    grp1 = nodes = n2;
    [ node, node2 ] = nodes;
    done();
  });
});

describe('bitcoind', function() {
  it('is running', function(done) {
    this.timeout(50000);
    net.waitForNodesS(nodes, 50000);
    done();
  });
});

describe('bitcointest', function() {
  it('can get balance', (done) => {
    const balance = node.getBalanceS();
    expect(balance).to.not.be.null;
    done();
  });
  
  it('can connect', function(done) {
    const results = net.connectNodesS(nodes);
    expect(results.length).to.equal(1);
    done();
  });
  
  it('can generate blocks', (done) => {
    node.generateBlocksS(101);
    done();
  });
  
  it('can send money between nodes', (done) => {
    const preBalance = node2.getBalanceS();
    node.sendToNodeS(node2, 1);
    const blocks = node.generateBlocksS(6);
    const newBalance = node2.waitForBalanceChangeS(preBalance);
    expect(newBalance).to.equal(preBalance + 1.0);
    done();
  });
  
  it('can get scriptPubKey for an address', (done) => {
    const addr = node.getNewAddressS();
    const spk = node.getScriptPubKeyS(addr);
    expect(spk).to.not.be.null;
    node.validateScriptPubKeyS(spk);
    done();
  });
  
  it('can create and fund a transaction to some node', (done) => {
    const addr = node2.getNewAddressS();
    const spk = node2.getScriptPubKeyS(addr);
    const recips = {};
    recips[addr] = 1;
    const { hex } = node.createAndFundTransactionS(recips);
    const tx = new Transaction(hex);
    let vout = null;
    for (const o of tx.vout) {
      if (o.scriptPubKey === spk) vout = o;
    }
    expect(vout).to.not.be.null;
    expect(tx.vin.length).to.not.equal(0);
    done();
  });
  
  it('can create double-spend transactions', (done) => {
    const rawtxes = node.createDoubleSpendTransactionS();
    expect(rawtxes.length).to.equal(2);
    const tx1 = new Transaction(rawtxes[0]);
    const tx2 = new Transaction(rawtxes[1]);
    expect(tx1).to.not.be.null;
    expect(tx2).to.not.be.null;
    expect(tx1.vin[0].prevout.hash).to.equal(tx2.vin[0].prevout.hash);
    expect(tx1.vin[0].prevout.n).to.equal(tx2.vin[0].prevout.n);
    done();
  });

  it('can connect groups of nodes', (done) => {
    const everyone = net.nodes;
    expect(everyone.length).to.equal(4);
    net.connectNodesS(everyone);
    for (let i = 0; i < everyone.length; i++) {
      for (let j = i + 1; j < everyone.length; j++) {
        expect(everyone[i].isConnected(everyone[j], true)).to.be.true;
      }
    }
    done();
  });
  
  it('can disconnect groups correctly', function(done) {
    expect(grp1.length).to.equal(2);
    expect(grp2.length).to.equal(2);
    net.disconnectGroupsS(grp1, grp2);
    for (let i = 0; i < grp1.length; i++) {
      for (let j = i + 1; j < grp1.length; j++) {
        expect(grp1[i].isConnected(grp1[j], true)).to.be.true;
      }
    }
    for (let i = 0; i < grp2.length; i++) {
      for (let j = i + 1; j < grp2.length; j++) {
        expect(grp2[i].isConnected(grp2[j], true)).to.be.true;
      }
    }
    for (let i = 0; i < grp1.length; i++) {
      for (let j = 0; j < grp2.length; j++) {
        expect(grp1[i].isConnected(grp2[j], true)).to.not.be.true;
      }
    }
    done();
  });
  
  it('can create partitions from arbitrary node lists', function(done) {
    const all = net.nodes;
    expect(all.length).to.equal(4);
    const nodeGroups = net.partitionS(all, 3);
    expect(nodeGroups.length).to.equal(3); // we wanted 3 groups, we should get 3
    expect(nodeGroups[0].length + nodeGroups[1].length + nodeGroups[2].length).to.equal(all.length); // all nodes should be included
    for (let grpIter = 0; grpIter < nodeGroups.length; grpIter++) {
      const grp1 = nodeGroups[grpIter];
      // connections within each group should exist
      for (let i = 0; i < grp1.length; i++) {
        for (let j = i + 1; j < grp1.length; j++) {
          expect(grp1[i].isConnected(grp1[j], true)).to.be.true;
        }
      }
      // connections between each group should not exist
      for (let grp2Iter = grpIter + 1; grp2Iter < nodeGroups; grp2Iter++) {
        const grp2 = nodeGroups[grp2Iter];
        for (let i = 0; i < grp1.length; j++) {
          for (let j = 0; j < grp2.length; j++) {
            expect(grp1[i].isConnected(grp2[j], true)).to.be.false;
          }
        }
      }
    }
    done();
  });
  
  it('does not make an empty partition for evenly spaced node lists', (done) => {
    const all = net.nodes;
    expect(all.length).to.equal(4);
    const nodeGroups = net.partitionS(all, 2);
    expect(nodeGroups.length).to.equal(2);
    expect(nodeGroups[0].length + nodeGroups[1].length).to.equal(all.length);
    done();
  });
  
  it('handles partitions with designations', function(done) {
    const all = net.nodes;
    expect(all.length).to.equal(4);
    // we want all[3] to go into group 0
    const designations = {
      0: [all[3]],
    };
    const nodeGroups = net.partitionS(all, 2, designations);
    expect(nodeGroups.length).to.equal(2);
    expect(nodeGroups[0].length + nodeGroups[1].length).to.equal(all.length);
    expect(nodeGroups[0][0].stringid()).to.equal(all[3].stringid());
    const seen = {};
    // one node in exactly one group
    for (const g of nodeGroups) {
      for (const n of g) {
        expect(seen[n.stringid()]).to.not.exist;
        seen[n.stringid()] = 1;
      }
    }
    // all nodes in a group
    for (const n of all) {
      expect(seen[n.stringid()]).to.exist;
    }
    done();
  });
  
  it('handles uneven partitions with designations', function(done) {
    this.timeout(6000);
    const all = net.nodes;
    expect(all.length).to.equal(4);
    // we want all[3] to go into group 0
    const designations = {
      0: [all[3]],
    };
    const nodeGroups = net.partitionS(all, 3, designations);
    expect(nodeGroups.length).to.equal(3);
    expect(nodeGroups[0].length + nodeGroups[1].length + nodeGroups[2].length).to.equal(all.length);
    expect(nodeGroups[0][0].stringid()).to.equal(all[3].stringid());
    const seen = {};
    // one node in exactly one group
    for (const g of nodeGroups) {
      for (const n of g) {
        expect(seen[n.stringid()]).to.not.exist;
        seen[n.stringid()] = 1;
      }
    }
    // all nodes in a group
    for (const n of all) {
      expect(seen[n.stringid()]).to.exist;
    }
    done();
  });
  
  const connectionCount = (nodes) => (nodes * (nodes - 1)) / 2;
  
  it('can merge arbitrary node lists', function(done) {
    const all = net.nodes;
    expect(all.length).to.equal(4);
    const results = net.mergeS(all);
    expect(results.length).to.equal(connectionCount(all.length));
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(all[i].isConnected(all[j], true)).to.be.true;
      }
    }
    done();
  });
  
  it('can send raw transactions', function(done) {
    this.timeout(20000);
    const addr = node2.getNewAddressS();
    const recipientDict = {};
    recipientDict[addr] = 1;
    const { hex, changepos, fee } = node.createAndFundTransactionS(recipientDict);
    const txid = node.sendRawTransactionS(hex, true);
    const result = node2.waitForTransactionS(txid, 15000);
    expect(result).to.not.be.false;
    done();
  });
  
  it('can find a spendable output', function(done) {
    const utxo = node.findSpendableOutputS(1);
    expect(utxo).to.exist;
    expect(utxo.amount).to.be.above(0.999);
    done();
  });
  
  it('can spend UTXOs', function(done) {
    this.timeout(5000);
    const utxo = node.findSpendableOutputS(1);
    const addr = node2.getNewAddressS();
    node.spendUTXOS(utxo, addr, 1);
    done();
  });
  
  it('can share an address to another node', function(done) {
    const utxo = node.findSpendableOutputS(1);
    node.shareAddressWithNodeS(node2, utxo.address, true);
    const addr = node.getNewAddressS();
    node2.spendUTXOS(utxo, addr, 1);
    done();
  });
  
  it('can sync', function(done) {
    this.timeout(10000);
    const all = net.nodes;
    net.mergeS(all);
    net.partitionS(all, 2);
    all[0].generateBlocksS(10);
    all[1].syncS(all[0]);
    net.mergeS(all),
    all[3].generateBlocksS(1);
    net.syncS(all);
    let prev = null;
    for (const node of all) {
      if (prev) {
        const state = node.getSyncStateS(prev);
        expect(state).to.be.true;
      }
      prev = node;
    }
    done();
  });
  
  it('shuts down', function(done) {
    this.timeout(10000);
    net.shutdownS();
    expect(node.running).to.be.false;
    expect(node2.running).to.be.false;
    done();
  });
});
