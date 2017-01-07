# bitcointest

Bitcoin test suite primarily used to test complex scenarios such as double spends and similar in the Bitcoin network.

The tests.js file contains several examples detailing what can be done.

## Quick Guide

Install the npm module `bitcointest`, and in a node project, do:

```javascript
const { BitcoinNet, BitcoinGraph } = require('bitcointest');
net = new BitcoinNet('/path/to/bitcoin', '/tmp/bitcointest/', 22001, 22002);
graph = new BitcoinGraph(net);

try {
    
    // TODO: write code here!
    
} catch (e) {
    net.shutdownS();
    throw e;
}
```

You can now set up clusters of regtest nodes as you desire. We wrap everything in a try/catch because we want to make sure the nodes are taken down in the event of an exception.

Note that starting a node up can take a long time, and you should `waitForNodes` before using them (it takes over 10 seconds in certain cases).

Note also that in the examples below, the `S`-suffix versions are being used. These are synchronous variants, which have equivalent non-`S` versions which take an additional callback in the form `(err, result)`.

```javascript
console.log('launching nodes');
const nodes = net.launchBatchS(4);
const [ n1, n2, n3, n4 ] = nodes;
net.waitForNodesS(nodes, 20000);
```

You can now do things with the nodes. Each node is an independent Bitcoin regtest node. Our nodes are currently disconnected. Let's connect all of them.

```javascript
net.mergeS(nodes);
```

Now that we've merged nodes, let's look at the connection matrix.

```javascript
console.log('current connection matrix:');
graph.printConnectionMatrix(nodes);
/*
    1   2   3   4
1  --  xo  xo  xo
2  ox  --  xo  xo
3  ox  ox  --  xo
4  ox  ox  ox  -- 
*/
```

Let's generate some blocks so we have something to spend.

```javascript
n1.generateBlocksS(1);
n2.generateBlocksS(110);
```

Now `n1` has 50 BTC and n2 has `500` available. Let's send some to `n3`.

```javascript
console.log(`n3.balance (before) = ${n3.getBalanceS()}`);
n2.sendToNodeS(n3, 100);
n2.generateBlocksS(6);
n3.waitForBalanceChangeS(0);
console.log(`n3.balance (after) = ${n3.getBalanceS()}`);
```

Two things of note above:

1. If we had generated blocks on any other node than `n2`, it would have not seen the transaction yet, and `n3`'s balance would have remained 0.
2. If we did not `n3.waitForBalanceChange`, we would have also probably gotten a zero balance, because the nodes would not have finished synchronizing these new blocks (our transaction to `n3` is inside the very first block of the 6 blocks).

## Double Spend Attack

Let's emulate a double spend attack. We do this in a few steps:

1. We split the network into two partitions (`n12` and `n34`).
2. We share a UTXO between `n2` and `n3`, so that they can both spend it independently.
3. We spend it on `n2`, sending it to `n1`, then generate 6 blocks on `n2`. `n1` should now think it owns the money sent by `n2`.
4. We spend it on `n3`, sending it to `n4`, then generate 6 blocks on `n3`. `n4` should now think it owns the money as well.
5. We reconnect the two partitions and generate on `n3`. This should trigger a reorg, and the UTXO should be spent to `n4`. `n1` should no longer believe it has the money it was sent earlier by `n2`.

Steps 1 - 2:
```javascript
const [ n12, n34 ] = net.partitionS(nodes, 2);

console.log('partitioned network:');
graph.printConnectionMatrix(nodes);
const n1addr = n1.getNewAddressS();
const n4addr = n4.getNewAddressS();
const utxo = n2.findSpendableOutputS(1);
n2.shareAddressWithNodeS(n3, utxo.address, true);
console.log(`n1 addr: ${n1addr}`);
console.log(`n4 addr: ${n4addr}`);
console.log(`utxo:    addr=${utxo.address}, amount=${utxo.amount}`);
```

We now have all we need to double-spend. First we do it from `n2` to `n1`.

Step 3:
```javascript
const n1PreBalance = n1.getBalanceS();
const txid = n2.spendUTXOS(utxo, n1addr, 1);
console.log(`n2->n1 txid = ${txid}`);
n1.waitForTransactionS(txid);
n2.generateBlocksS(6);
n1.waitForBalanceChangeS(n1PreBalance);
const n1PostBalance = n1.getBalanceS();
console.log(`n1 balance +${n1PostBalance - n1PreBalance}: pre=${n1PreBalance}, post=${n1PostBalance}`);
```

We can now spend the same UTXO from `n3` in the same fashion. Before we do, let's see what the block chains look like in the current partitioned state:

```javascript
net.syncS(n12);
console.log('block chain state:');
console.log('  n1+n2           n3+n4');
graph.printBlockChainsS(n12, n34);
/*
  n1+n2           n3+n4
        0f9188f1
        593e2695
        6096d4c6
        ...
        45f4fe97
        35076969
        00cc436c
723ec341
04357b98
4bc193b8
3ea5ce1c
6dfc05c9
71977563
*/
```

As you can see, nodes `n3+n4` have not see the last 6 blocks, which is because they are disconnected from `n1+n2`. 

Now spend the same UTXO from n3.

Step 4:
```javascript
const n4PreBalance = n4.getBalanceS();
const txid2 = n3.spendUTXOS(utxo, n4addr, 1);
console.log(`n3->n4 txid = ${txid2}`);
n4.waitForTransactionS(txid2);
n3.generateBlocksS(6);
n4.waitForBalanceChangeS(n4PreBalance);
const n4PostBalance = n4.getBalanceS();
console.log(`n4 balance +${n4PostBalance - n4PreBalance}: pre=${n4PreBalance}, post=${n4PostBalance}`);
```

Looking at the block chain state...

```javascript
console.log('block chain state:');
console.log('  n1+n2           n3+n4');
net.syncS(n34);
graph.printBlockChainsS(n12, n34);
/*
  n1+n2           n3+n4
        0f9188f1
        593e2695
        6096d4c6
        ...
        45f4fe97
        35076969
        00cc436c
723ec341        7cf9ba37
04357b98        13f7c591
4bc193b8        029002ea
3ea5ce1c        18089dd4
6dfc05c9        2d6854dc
71977563        1485ce28
*/
```

... we see that a fork has occurred. This fork will survive for as long as the two partitions are separated. Once the network is merged, the net will perform a reorg, and the longest chain will become the new active one, as seen by the nodes. We force the longest chain to be the `n34` one, by generating on `n3`. Final step.

Step 5:
```javascript
net.mergeS(nodes);
n3.generateBlocksS(1);
net.syncS(nodes);
// show block chain state
console.log('block chain state after merge/sync:');
graph.printBlockChainsS(n12, n34);
/*
        0f9188f1
        593e2695
        6096d4c6
        ...
        2d6854dc
        1485ce28
        49611629
 */
// n1 balance should have gone back to unchanged
const n1FinalBalance = n1.getBalanceS();
const n4FinalBalance = n4.getBalanceS();
console.log(`n1 final balance = ${n1FinalBalance} (starting balance ${n1PreBalance})`);
console.log(`n4 final balance = ${n4FinalBalance} (starting balance ${n4PreBalance})`);
/*
n1 final balance = 0 (starting balance 0)
n4 final balance = 1 (starting balance 0)
 */
```
