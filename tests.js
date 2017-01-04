/* global describe it */
/* eslint import/no-extraneous-dependencies: 0 */
/* eslint no-console: 0 */
/* eslint no-unused-expressions: 0 */

const chai = require('chai');
const { Node, BitcoinNet, Transaction } = require('./index');
const async = require('async');

const expect = chai.expect;
let net;
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
       net = new BitcoinNet(bitcoinPath, '/tmp/bctest/', 22001, 22002);
       expect(net).to.not.be.null;
       done();
    });
  });
});

describe('BitcoinNet', () => {
  it('launches nodes', (done) => {
    net.launchBatch(2, (err, n) => {
      expect(err).to.be.null;
      expect(n.length).to.equal(2);
      grp2 = n;
      net.launchBatch(2, (err2, n2) => {
        expect(err2).to.be.null;
        expect(n2.length).to.equal(2);
        grp1 = nodes = n2;
        [ node, node2 ] = nodes;
        done();
      });
    });
  });
});

describe('bitcoind', function() {
  it('is running', function(done) {
    this.timeout(20000);
    net.waitForNodes(nodes, 20000, (err) => {
      expect(err).to.be.null;
      done();
    });
  });
});

describe('bctest', function() {
  it('can get balance', (done) => {
    node.getBalance((err, balance) => {
      expect(err).to.be.null;
      expect(balance).to.not.be.null;
      done();
    });
  });
  
  it('can connect', function(done) {
    net.connectNodes(nodes, (err, results) => {
      expect(err).to.be.null;
      expect(results.length).to.equal(1);
      done();
    });
  });
  
  it('can generate blocks', (done) => {
    node.generateBlocks(101, (err) => {
      if (err) console.log(`err=${JSON.stringify(err)}`);
      expect(err).to.be.null;
      done();
    });
  });
  
  it('can send money between nodes', (done) => {
    let preBalance;
    async.waterfall([
      (c) => node2.getBalance(c),
      (preBalanceIn, c) => {
        preBalance = preBalanceIn;
        node.sendToNode(node2, 1, c);
      },
      (txid, c) => node.generateBlocks(6, c),
      (blocks, c) => node2.waitForBalanceChange(preBalance, c),
      (newBalance, c) => {
        expect(newBalance).to.equal(preBalance + 1.0);
        c();
      }
    ],
    (err) => {
      if (err) console.log(`err=${JSON.stringify(err)}`);
      done(err);
    });
  });
  
  it('can get scriptPubKey for an address', (done) => {
    node.getNewAddress((err, addr) => {
      expect(err).to.be.null;
      node.getScriptPubKey(addr, (err2, spk) => {
        expect(err2).to.be.null;
        expect(spk).to.not.be.null;
        node.validateScriptPubKey(spk, (err3) => {
          expect(err3).to.be.null;
          done();
        });
      });
    });
  });
  
  it('can create and fund a transaction to some node', (done) => {
    node2.getNewAddress((err, addr) => {
      expect(err).to.be.null;
      node2.getScriptPubKey(addr, (err2, spk) => {
        expect(err2).to.be.null;
        const recips = {};
        recips[addr] = 1;
        node.createAndFundTransaction(recips, (err3, rawtx) => {
          expect(err3).to.be.null;
          const tx = new Transaction(rawtx);
          let vout = null;
          for (const o of tx.vout) {
            if (o.scriptPubKey === spk) vout = o;
          }
          expect(vout).to.not.be.null;
          expect(tx.vin.length).to.not.equal(0);
          done();
        });
      });
    });
  });
  
  it('can create double-spend transactions', (done) => {
    node.createDoubleSpendTransaction((err, rawtxes) => {
      expect(err).to.be.null;
      expect(rawtxes.length).to.equal(2);
      const tx1 = new Transaction(rawtxes[0]);
      const tx2 = new Transaction(rawtxes[1]);
      expect(tx1).to.not.be.null;
      expect(tx2).to.not.be.null;
      expect(tx1.vin[0].prevout.hash).to.equal(tx2.vin[0].prevout.hash);
      expect(tx1.vin[0].prevout.n).to.equal(tx2.vin[0].prevout.n);
      done();
    });
  });

  it('can connect groups of nodes', (done) => {
    const everyone = net.nodes;
    expect(everyone.length).to.equal(4);
    net.connectNodes(everyone, (err) => {
      expect(err).to.be.null;
      for (let i = 0; i < everyone.length; i++) {
        for (let j = i + 1; j < everyone.length; j++) {
          expect(everyone[i].isConnected(everyone[j], true)).to.be.true;
        }
      }
      done();
    });
  });
  
  it('can disconnect groups correctly', function(done) {
    expect(grp1.length).to.equal(2);
    expect(grp2.length).to.equal(2);
    net.disconnectGroups(grp1, grp2, (err) => {
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
  });
  
  it('can create partitions from arbitrary node lists', function(done) {
    const all = net.nodes;
    expect(all.length).to.equal(4);
    net.partition(all, 3, (err, nodeGroups) => {
      expect(err).to.be.null;
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
  });
  
  it('does not make an empty partition for evenly spaced node lists', (done) => {
    const all = net.nodes;
    expect(all.length).to.equal(4);
    net.partition(all, 2, (err, nodeGroups) => {
      expect(err).to.be.null;
      expect(nodeGroups.length).to.equal(2);
      expect(nodeGroups[0].length + nodeGroups[1].length).to.equal(all.length);
      done();
    });
  });
  
  it('handles partitions with designations', (done) => {
    const all = net.nodes;
    expect(all.length).to.equal(4);
    // we want all[3] to go into group 0
    const designations = {
      0: [all[3]],
    };
    net.partition(all, 2, designations, (err, nodeGroups) => {
      if (err) console.log(`err=${JSON.stringify(err)}`);
      expect(err).to.be.null;
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
  });
  
  it('handles uneven partitions with designations', (done) => {
    const all = net.nodes;
    expect(all.length).to.equal(4);
    // we want all[3] to go into group 0
    const designations = {
      0: [all[3]],
    };
    net.partition(all, 3, designations, (err, nodeGroups) => {
      expect(err).to.be.null;
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
  });
  
  const connectionCount = (nodes) => (nodes * (nodes - 1)) / 2;
  
  it('can merge arbitrary node lists', function(done) {
    const all = net.nodes;
    expect(all.length).to.equal(4);
    net.merge(all, (err, results) => {
      expect(err).to.be.null;
      expect(results.length).to.equal(connectionCount(all.length));
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          expect(all[i].isConnected(all[j], true)).to.be.true;
        }
      }
      done();
    });
  });
  
  it('can send raw transactions', function(done) {
    this.timeout(20000);
    let txid;
    async.waterfall([
      (c) => node2.getNewAddress(c), 
      (addr, c) => {
        const recipientDict = {};
        recipientDict[addr] = 1;
        node.createAndFundTransaction(recipientDict, c);
      },
      (rawtx, changepos, fee, c) => node.sendRawTransaction(rawtx, true, c),
      (txidIn, c) => node2.waitForTransaction(txidIn, 15000, c),
      (result, c) => {
        expect(result).to.not.be.false;
        c();
      },
    ],
    (err) => {
      if (err) console.log(`err=${JSON.stringify(err)}`);
      expect(err).to.be.null;
      done();
    });
  });
  
  it('can find a spendable output', function(done) {
    node.findSpendableOutput(1, (err, utxo) => {
      expect(err).to.be.null;
      expect(utxo).to.exist;
      expect(utxo.amount).to.be.above(0.999);
      done();
    });
  });
  
  it('can spend UTXOs', function(done) {
    this.timeout(5000);
    node.findSpendableOutput(1, (err, utxo) => {
      expect(err).to.be.null;
      node2.getNewAddress((err2, addr) => {
        expect(err2).to.be.null;
        node.spendUTXO(utxo, addr, 1, (err3) => {
          if (err3) console.log(`err=${JSON.stringify(err3)}`);
          expect(err3).to.be.null;
          done();
        });
      });
    });
  });
  
  it('can share an address to another node', function(done) {
    node.findSpendableOutput(1, (err, utxo) => {
      if (err) console.log(`err=${JSON.stringify(err)}`);
      expect(err).to.be.null;
      node.shareAddressWithNode(node2, utxo.address, true, (err2) => {
        if (err2) console.log(`err=2${JSON.stringify(err2)}`);
        expect(err2).to.be.null;
        node.getNewAddress((err3, addr) => {
          if (err3) console.log(`err=3${JSON.stringify(err3)}`);
          expect(err3).to.be.null;
          node2.spendUTXO(utxo, addr, 1, (err4) => {
            if (err4) console.log(`err=4${JSON.stringify(err4)}`);
            expect(err4).to.be.null;
            done();
          });
        });
      });
    });
  });
  
  it('shuts down', function(done) {
    net.shutdown(() => {
      expect(node.running).to.be.false;
      expect(node2.running).to.be.false;
      done();
    });
  });
});
