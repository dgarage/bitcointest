/* global describe it */
/* eslint import/no-extraneous-dependencies: 0 */
/* eslint no-console: 0 */
/* eslint no-unused-expressions: 0 */

const chai = require('chai');
const { Node, BitcoinNet, Transaction } = require('./index');
const async = require('async');

const expect = chai.expect;
let net;
let nodes;
let node;
let node2;

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
  it('launches 2 nodes', (done) => {
    net.launchBatch(2, (err, n) => {
      expect(err).to.be.null;
      expect(n.length).to.equal(2);
      nodes = n;
      [ node, node2 ] = nodes;
      done();
    });
  });
});

describe('bitcoind', function() {
  it('is running', function(done) {
    this.timeout(10000);
    net.waitForNodes(nodes, 10000, (err) => {
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
      expect(err).to.be.null;
      done();
    });
  });
  
  it('can send money between nodes', (done) => {
    node2.getBalance((err, preBalance) => {
      expect(err).to.be.null;
      node.sendToNode(node2, 1, (err2) => {
        expect(err2).to.be.null;
        node.generateBlocks(6, (err3) => {
          expect(err3).to.be.null;
          node2.waitForBalanceChange(preBalance, (err4, newBalance) => {
            expect(err4).to.be.null;
            expect(newBalance).to.equal(preBalance + 1.0);
            done();
          });
        });
      });
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
  
  it('can fund a transaction to some node', (done) => {
    node2.getNewAddress((err, addr) => {
      expect(err).to.be.null;
      node2.getScriptPubKey(addr, (err2, spk) => {
        expect(err2).to.be.null;
        const recips = {};
        recips[addr] = 1;
        node.fundTransaction(recips, (err3, rawtx) => {
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
  
  it('shuts down', function(done) {
    net.shutdown(() => {
      expect(node.running).to.be.false;
      expect(node2.running).to.be.false;
      done();
    });
  });
});
