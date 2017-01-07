# bitcointest

Bitcoin test suite primarily used to test complex scenarios such as double spends and similar in the Bitcoin network.

The tests.js file contains several examples detailing what can be done.

[![demo](doc/demo.gif)](#)

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

The two letters are *outgoing* and *incoming* respectively. `o` = open, `x` = closed. In reality, there is a two-way connection between all nodes, but internally (to `bitcointest`), this is retained as a single connection. In other words, all nodes are connected to each other. 

Let's generate some blocks so we have something to spend.

```javascript
n1.generateBlocksS(1);
n2.generateBlocksS(110);
```

Now `n1` has 50 BTC and `n2` has `500` available. Let's send some to `n3`.

```javascript
console.log(`n3.balance (before) = ${n3.getBalanceS()}`);
// n3.balance (before) = 0
const sometxid = n2.sendToNodeS(n3, 100);
n2.generateBlocksS(6);
n3.waitForBalanceChangeS(0);
const sometx = n3.getTransactionS(sometxid);
console.log(`n3.balance (after) = ${n3.getBalanceS()}`);
// n3.balance (after) = 100
console.log(`tx ${sometxid}: ${JSON.stringify(sometx, false, '  ')}`);
/*
tx 04ba4cd30be191e790b5aaf856ad2c919bb917962929580e0d9a71f13c84a526: {
  "amount": 100,
  "confirmations": 6,
  "blockhash": "340d5df29f5dc89249adcbc5434d1e19bf2156456ff7c6e87b3396e8c6d5c854",
  "blockindex": 1,
  "blocktime": 1483765239,
  "txid": "04ba4cd30be191e790b5aaf856ad2c919bb917962929580e0d9a71f13c84a526",
  "walletconflicts": [],
  "time": 1483765236,
  "timereceived": 1483765236,
  "bip125-replaceable": "no",
  "details": [
    {
      "account": "",
      "address": "mzmZ16R1NQRnU1bvEgy6iGvbPrGzkoN4CS",
      "category": "receive",
      "amount": 100,
      "label": "",
      "vout": 0
    }
  ],
  "hex": "0200000003b7ddc67ce1f7cf9cb5c85c91a1ac1d417577691c1b6f09e1ba986e2302151da70000000048473044022046bfb842d6f4f30a3fe200ebe8282413361cdc6a69b4a8f05849214c960cf40d02205f93c5028fd740c6643a811029e99fecb6337b54280c933a63025acc8aac0c2101feffffff5a0c52522a39ea6737b3cca7469ebd04549c2a2d59ec5007c9d81d3c769c66580000000049483045022100a3051c672cb3d5a485dfe09eb510ed314ea828ce6d5559a402a61dcf6388b4f702200537a79e07b49d25d0e2f70c75058322510f71de7124e49e8c31f263b29471a501feffffff05c8b83871400f69cae3501d095287ae0d9e659145cbb531dab73c80dd5064c0000000004847304402203ec40b8edb61ca7d40dbf5e7c5084b4b5e51effd7aee1171c81134cb22e580ea0220757abb775cb36e052125909043c8e53d33947b666aa61768445ac47b1ba0b18901feffffff0200e40b54020000001976a914d32d2f901d079ae83411172ed83f46e4c60e71dd88ac58d1052a010000001976a914a4526dc0a72f2ce436ee7a0a8364d68c40e0065988ac6e000000"
}
*/
```

Two things of note above:

1. If we had generated blocks on any other node than `n2`, it would have not seen the transaction yet, and `n3`'s balance would have remained 0.
2. If we did not `n3.waitForBalanceChange`, we would have also probably gotten a zero balance, because the nodes would not have finished synchronizing these new blocks (our transaction to `n3` is inside the very first block of the 6 blocks).

## Double Spend Theft Demo

Let's emulate a double spend. There are several kinds of Double Spends, and we will cover two of them here. In the first case we will send money to one person and then send it to someone else. The first person will think they got the money, but then the money will instead go to the second person (ourselves, for example). We do this in a few steps:

1. We split the network into two partitions (`n12` and `n34`).
2. We share a UTXO between `n2` and `n3`, so that they can both spend it independently.
3. We spend it on `n2`, sending it to `n1`, then generate 6 blocks on `n2`. `n1` should now think it owns the money sent by `n2`.
4. We spend it on `n3`, sending it to `n4`, then generate 6 blocks on `n3`. `n4` should now think it owns the money as well.
5. We reconnect the two partitions and generate on `n3`. This should trigger a reorg, and the UTXO spent by `n3` to `n4` should become the accepted one. `n1` should no longer believe it has the money it was sent earlier by `n2`.

Steps 1 - 2:
```javascript
const [ n12, n34 ] = net.partitionS(nodes, 2);

console.log('partitioned network:');
graph.printConnectionMatrix(nodes);
/*
    1   2   3   4
1  --  xo  xx  xx
2  ox  --  xx  xx
3  xx  xx  --  xo
4  xx  xx  ox  --
*/
const n1addr = n1.getNewAddressS();
const n4addr = n4.getNewAddressS();
const utxo = n2.findSpendableOutputS(1);
n2.shareAddressWithNodeS(n3, utxo.address, true);
console.log(`n1 addr: ${n1addr}`);
console.log(`n4 addr: ${n4addr}`);
console.log(`utxo:    addr=${utxo.address}, amount=${utxo.amount}`);
/*
n1 addr: mkkGp38vSZrtaNzPJb9xa4Xf8Cj93xQ24s
n4 addr: mksXZTCXPZDQi4W8HJgVFXsaP287P7pevs
utxo:    addr=mkiVX8qmeWL57ccxvhpnz4QA1gsbTFK1qj, amount=50
*/
```

We now have all we need to double-spend. First we do it from `n2` to `n1`.

Step 3:
```javascript
const n1PreBalance = n1.getBalanceS();
const txid = n2.spendUTXOS(utxo, n1addr, 1);
console.log(`n2->n1 txid = ${txid}`);
// n2->n1 txid = 0a2c1098c74ed7767051412806ea427f21d255d7aa812001db9e71781753140e
n1.waitForTransactionS(txid);
// 'mempool'
n2.generateBlocksS(6);
n1.waitForBalanceChangeS(n1PreBalance);
const n1PostBalance = n1.getBalanceS();
const confirmedTX = n1.getTransactionS(txid);
console.log(`n1 balance +${n1PostBalance - n1PreBalance}: pre=${n1PreBalance}, post=${n1PostBalance}`);
// n1 balance +1: pre=0, post=1
console.log(`tx ${txid} according to n1 at this point in time: ${JSON.stringify(confirmedTX, false, '  ')}`);
/*
tx 0a2c1098c74ed7767051412806ea427f21d255d7aa812001db9e71781753140e according to n1 at this point in time: {
  "amount": 1,
  "confirmations": 6,
  "blockhash": "464d3a7c604baa0de5630392ce67490f4122097a4e48226fca302e8d5fa02689",
  "blockindex": 1,
  "blocktime": 1483765350,
  "txid": "0a2c1098c74ed7767051412806ea427f21d255d7aa812001db9e71781753140e",
  "walletconflicts": [],
  "time": 1483765343,
  "timereceived": 1483765343,
  "bip125-replaceable": "no",
  "details": [
    {
      "account": "",
      "address": "mkkGp38vSZrtaNzPJb9xa4Xf8Cj93xQ24s",
      "category": "receive",
      "amount": 1,
      "label": "",
      "vout": 0
    }
  ],
  "hex": "02000000010a93cae30517e73597d1bbb5704e3f7dd2f1301568306d47bc4a9cbb897c8b190000000049483045022100f9e767e78da68a896f799ad1b289bcd00f21e717fec696ed3fa8db5a1ed42024022029b492d995d328eaafa40a494535eca003648b40b9ed7e57fd76e2cd8100864f01ffffffff0200e1f505000000001976a914395d7e5ca706a4357f75e8c6d8a78de90520c8ac88acd09b0f24010000001976a914b6f714df2f6175affa3fb4f8cd00fa9ecb7662ab88ac00000000"
}
*/
```

We can now spend the same UTXO from `n3` in the same fashion. Before we do, let's see what the block chains look like in the current partitioned state:

```javascript
net.syncS(n12);
console.log('block chain state:');
console.log('  n1+n2           n3+n4');
graph.printBlockChainsS(n12, n34);
/*
block chain state:
  n1+n2           n3+n4
        0f9188f1
        348ddc14
        2de5d326
        ...
        7220caf3
        3ee5623d
        60921d7a
464d3a7c
22312068
775048f6
029eefbc
56a4359d
7fa3d2f9
*/
```

As you can see, nodes `n3+n4` have not see the last 6 blocks, which is because they are disconnected from `n1+n2`. 

Now spend the same UTXO from `n3`.

Step 4:
```javascript
const n4PreBalance = n4.getBalanceS();
const txid2 = n3.spendUTXOS(utxo, n4addr, 1);
console.log(`n3->n4 txid = ${txid2}`);
// n3->n4 txid = 4262451530cfc93305db7e4eb4744a4f12f0080a6a39ee1211bb52850dc6ccb7
n4.waitForTransactionS(txid2);
// 'mempool'
n3.generateBlocksS(6);
n4.waitForBalanceChangeS(n4PreBalance);
const n4PostBalance = n4.getBalanceS();
console.log(`n4 balance +${n4PostBalance - n4PreBalance}: pre=${n4PreBalance}, post=${n4PostBalance}`);
// n4 balance +1: pre=0, post=1
```

Looking at the block chain state...

```javascript
net.syncS(n34);
console.log('block chain state:');
console.log('  n1+n2           n3+n4');
graph.printBlockChainsS(n12, n34);
/*
block chain state:
  n1+n2           n3+n4
        0f9188f1
        348ddc14
        2de5d326
        ...
        7220caf3
        3ee5623d
        60921d7a
464d3a7c        4ccf1684
22312068        3cd8b1e9
775048f6        43b4f097
029eefbc        72a56e84
56a4359d        1594a550
7fa3d2f9        670f5a40
*/
```

... we see that a fork has occurred. This fork will survive for as long as the two partitions are separated. Once the network is merged, the net will perform a reorg, and the longest chain will become the new active one (not 100% but mostly true), as seen by the nodes. Before we do that, let's take a closer look at the two conflicting transactions.

```javascript
const tx1Details = n1.getTransactionS(txid, true); // true = detailed (getrawtx instead of gettx)
const tx2Details = n4.getTransactionS(txid2, true);
console.log(`first transaction: ${JSON.stringify(tx1Details, false, '  ')}`);
/*
first transaction: {
  "hex": "02000000010a93cae30517e73597d1bbb5704e3f7dd2f1301568306d47bc4a9cbb897c8b190000000049483045022100f9e767e78da68a896f799ad1b289bcd00f21e717fec696ed3fa8db5a1ed42024022029b492d995d328eaafa40a494535eca003648b40b9ed7e57fd76e2cd8100864f01ffffffff0200e1f505000000001976a914395d7e5ca706a4357f75e8c6d8a78de90520c8ac88acd09b0f24010000001976a914b6f714df2f6175affa3fb4f8cd00fa9ecb7662ab88ac00000000",
  "txid": "0a2c1098c74ed7767051412806ea427f21d255d7aa812001db9e71781753140e",
  "hash": "0a2c1098c74ed7767051412806ea427f21d255d7aa812001db9e71781753140e",
  "size": 192,
  "vsize": 192,
  "version": 2,
  "locktime": 0,
  "vin": [
    {
      "txid": "198b7c89bb9c4abc476d30681530f1d27d3f4e70b5bbd19735e71705e3ca930a",
      "vout": 0,
      "scriptSig": {
        "asm": "3045022100f9e767e78da68a896f799ad1b289bcd00f21e717fec696ed3fa8db5a1ed42024022029b492d995d328eaafa40a494535eca003648b40b9ed7e57fd76e2cd8100864f[ALL]",
        "hex": "483045022100f9e767e78da68a896f799ad1b289bcd00f21e717fec696ed3fa8db5a1ed42024022029b492d995d328eaafa40a494535eca003648b40b9ed7e57fd76e2cd8100864f01"
      },
      "sequence": 4294967295
    }
  ],
  "vout": [
    {
      "value": 1,
      "n": 0,
      "scriptPubKey": {
        "asm": "OP_DUP OP_HASH160 395d7e5ca706a4357f75e8c6d8a78de90520c8ac OP_EQUALVERIFY OP_CHECKSIG",
        "hex": "76a914395d7e5ca706a4357f75e8c6d8a78de90520c8ac88ac",
        "reqSigs": 1,
        "type": "pubkeyhash",
        "addresses": [
          "mkkGp38vSZrtaNzPJb9xa4Xf8Cj93xQ24s"
        ]
      }
    },
    {
      "value": 48.9997,
      "n": 1,
      "scriptPubKey": {
        "asm": "OP_DUP OP_HASH160 b6f714df2f6175affa3fb4f8cd00fa9ecb7662ab OP_EQUALVERIFY OP_CHECKSIG",
        "hex": "76a914b6f714df2f6175affa3fb4f8cd00fa9ecb7662ab88ac",
        "reqSigs": 1,
        "type": "pubkeyhash",
        "addresses": [
          "mxCPGVYFhiayMuBvG5FPqgYoZBMRfT5yuE"
        ]
      }
    }
  ],
  "blockhash": "464d3a7c604baa0de5630392ce67490f4122097a4e48226fca302e8d5fa02689",
  "confirmations": 6,
  "time": 1483765350,
  "blocktime": 1483765350
}
*/
console.log(`second transaction: ${JSON.stringify(tx2Details, false, '  ')}`);
/*
second transaction: {
  "hex": "02000000010a93cae30517e73597d1bbb5704e3f7dd2f1301568306d47bc4a9cbb897c8b190000000049483045022100f034f52cb7eaeb32a258728dba549337706fabf017e7a5f10abc878f7e88ade7022063a2ae94f144da852959cdde76403202825e799af6926b8061df48a03da543ae01ffffffff0200e1f505000000001976a9143abcb77f721b3f916fe6b1fecdc9cdd8bba6c80988acd09b0f24010000001976a914f71ca0aca82b684cde4e23874120184a93ae765d88ac00000000",
  "txid": "4262451530cfc93305db7e4eb4744a4f12f0080a6a39ee1211bb52850dc6ccb7",
  "hash": "4262451530cfc93305db7e4eb4744a4f12f0080a6a39ee1211bb52850dc6ccb7",
  "size": 192,
  "vsize": 192,
  "version": 2,
  "locktime": 0,
  "vin": [
    {
      "txid": "198b7c89bb9c4abc476d30681530f1d27d3f4e70b5bbd19735e71705e3ca930a",
      "vout": 0,
      "scriptSig": {
        "asm": "3045022100f034f52cb7eaeb32a258728dba549337706fabf017e7a5f10abc878f7e88ade7022063a2ae94f144da852959cdde76403202825e799af6926b8061df48a03da543ae[ALL]",
        "hex": "483045022100f034f52cb7eaeb32a258728dba549337706fabf017e7a5f10abc878f7e88ade7022063a2ae94f144da852959cdde76403202825e799af6926b8061df48a03da543ae01"
      },
      "sequence": 4294967295
    }
  ],
  "vout": [
    {
      "value": 1,
      "n": 0,
      "scriptPubKey": {
        "asm": "OP_DUP OP_HASH160 3abcb77f721b3f916fe6b1fecdc9cdd8bba6c809 OP_EQUALVERIFY OP_CHECKSIG",
        "hex": "76a9143abcb77f721b3f916fe6b1fecdc9cdd8bba6c80988ac",
        "reqSigs": 1,
        "type": "pubkeyhash",
        "addresses": [
          "mksXZTCXPZDQi4W8HJgVFXsaP287P7pevs"
        ]
      }
    },
    {
      "value": 48.9997,
      "n": 1,
      "scriptPubKey": {
        "asm": "OP_DUP OP_HASH160 f71ca0aca82b684cde4e23874120184a93ae765d OP_EQUALVERIFY OP_CHECKSIG",
        "hex": "76a914f71ca0aca82b684cde4e23874120184a93ae765d88ac",
        "reqSigs": 1,
        "type": "pubkeyhash",
        "addresses": [
          "n43ZVX4MALEAXUBW4MyXBVDe612f363wGD"
        ]
      }
    }
  ],
  "blockhash": "4ccf168436e9ad00d1f643fadb3b03c8fae37eb9c235ec132d70eaa49f13067a",
  "confirmations": 6,
  "time": 1483765425,
  "blocktime": 1483765425
}
*/
```

Note that the `txid` of the `vin` for both transactions is equal to `198b7c89bb9c4abc476d30681530f1d27d3f4e70b5bbd19735e71705e3ca930a`.

We now force the longest chain to be the `n34` one, by generating on `n3`. Final step.

Step 5:
```javascript
net.mergeS(nodes);
n3.generateBlocksS(1);
net.syncS(nodes);
// show block chain state
console.log('block chain state after merge/sync:');
graph.printBlockChainsS(n12, n34);
/*
block chain state after merge/sync:
        0f9188f1
        348ddc14
        2de5d326
        ...
        1594a550
        670f5a40
        4ed844b4
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

While looking at the balance is a fast way to check how things changed, it isn't recommended. A better option is to keep track of the individual transactions and react accordingly when they change. In this case, let's see how `n1` considers the transaction that has now been discarded by the network:

```javascript
console.log(JSON.stringify(n1.getTransactionS(txid), false, '  '));
/*
{
  "amount": 1,
  "confirmations": -7,
  "trusted": false,
  "txid": "0a2c1098c74ed7767051412806ea427f21d255d7aa812001db9e71781753140e",
  "walletconflicts": [],
  "time": 1483765343,
  "timereceived": 1483765343,
  "bip125-replaceable": "unknown",
  "details": [],
  "hex": "02000000010a93cae30517e73597d1bbb5704e3f7dd2f1301568306d47bc4a9cbb897c8b190000000049483045022100f9e767e78da68a896f799ad1b289bcd00f21e717fec696ed3fa8db5a1ed42024022029b492d995d328eaafa40a494535eca003648b40b9ed7e57fd76e2cd8100864f01ffffffff0200e1f505000000001976a914395d7e5ca706a4357f75e8c6d8a78de90520c8ac88acd09b0f24010000001976a914b6f714df2f6175affa3fb4f8cd00fa9ecb7662ab88ac00000000"
}
*/
```

As you can see, `confirmations` has now gone negative, which basically means this transaction is `7` blocks away from the current block state. The blockhash value has vanished as well, indicating that the transaction is, indeed, no longer in a block.

A sidenote here is that, for transactions that are no longer a part of the main chain, you cannot get detailed information (`getTransaction(id, true)`). The reason for this is that, under the hood, `details=false` calls the RPC command `gettransaction`, which works for orphaned transactions, and `details=true` calls `getrawtransaction`, which does not work in these circumstances.

## Double Spend Same Destination

The "Double Spend Same Destination" case works just like "Double Spend Theft", except both transactions send to the same address. A common example of this is an RBF (Replace By Fee) transaction, an opt-in feature in the bitcoin network where a transaction can be replaced with another transaction with a higher fee, as long as the transaction is not in a block already.

We will do this in the same fashion as before. 

1. Get a shared UTXO between two separate nodes. 
2. Get an address (the `invoice` number). `n1` is the merchant we are paying.
3. Send to the address from `n2`. Generate blocks. `n1` should now think it has half the amount.
4. Send to the address from `n3`. Generate blocks.
5. Merge network. Generate blocks on `n3`. `n1` may (but should not) think it received the second half.

```javascript
net.partitionS(nodes, 2);
// Step 1
const utxo2 = n2.findSpendableOutputS(1);
n2.shareAddressWithNodeS(n3, utxo2.address, true);
// Step 2
const invoice = n1.getNewAddressS();
console.log(`our invoice = ${invoice}`);
console.log(`utxo        = addr:${utxo2.address}, amount:${utxo2.amount}`);
// our invoice = mzss6gmiPzciFb1QrVATkr4jWfaqbYg8Hx
// utxo        = addr:mvVormA71jfVkNVaGbRG5GNXUth5hDmoo7, amount:49.9999164
// Step 3
const payment1txid = n2.spendUTXOS(utxo2, invoice, 1);
console.log(`payment 1 (first half) txid=${payment1txid}`);
// payment 1 (first half) txid=4fa0d47ca775b2b300a02a16a6f7ce51b880f8e0c896b490c81fa69196207170
n1.waitForTransactionS(payment1txid);
n2.generateBlocksS(6);
// Step 4
const payment2txid = n3.spendUTXOS(utxo2, invoice, 1);
console.log(`payment 2 (second half) txid=${payment2txid}`);
// payment 2 (second half) txid=560f0ea66e5c16838e675394908e20befa22a2dcfa9be49f919e48e53ea3dcc6
n3.generateBlocksS(6);
```

Before we merge, let's look at the transactions in detail.

```javascript
console.log(JSON.stringify(n1.getTransactionS(payment1txid, true), false, '  '));
/*
{
  "hex": "020000000126a5843cf1719a0d0e5829299617b99b912cad56f8aab590e791e10bd34cba040100000069463043021f15fc82b830c60564f7e652f60a2b88253640312c5eae92425c18e85ec4507e022063831644be2c194d10752dcd847f3b9212e7d58e66483622bfe9578d2546129001210360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086fffffffff0200e1f505000000001976a914d45ec9a653a1852acd4c2173155a3cd5d25fe50e88ac30150e24010000001976a91425f1227565322012eba2500152cd60fd7531044188ac00000000",
  "txid": "4fa0d47ca775b2b300a02a16a6f7ce51b880f8e0c896b490c81fa69196207170",
  "hash": "4fa0d47ca775b2b300a02a16a6f7ce51b880f8e0c896b490c81fa69196207170",
  "size": 224,
  "vsize": 224,
  "version": 2,
  "locktime": 0,
  "vin": [
    {
      "txid": "04ba4cd30be191e790b5aaf856ad2c919bb917962929580e0d9a71f13c84a526",
      "vout": 1,
      "scriptSig": {
        "asm": "3043021f15fc82b830c60564f7e652f60a2b88253640312c5eae92425c18e85ec4507e022063831644be2c194d10752dcd847f3b9212e7d58e66483622bfe9578d25461290[ALL] 0360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086f",
        "hex": "463043021f15fc82b830c60564f7e652f60a2b88253640312c5eae92425c18e85ec4507e022063831644be2c194d10752dcd847f3b9212e7d58e66483622bfe9578d2546129001210360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086f"
      },
      "sequence": 4294967295
    }
  ],
  "vout": [
    {
      "value": 1,
      "n": 0,
      "scriptPubKey": {
        "asm": "OP_DUP OP_HASH160 d45ec9a653a1852acd4c2173155a3cd5d25fe50e OP_EQUALVERIFY OP_CHECKSIG",
        "hex": "76a914d45ec9a653a1852acd4c2173155a3cd5d25fe50e88ac",
        "reqSigs": 1,
        "type": "pubkeyhash",
        "addresses": [
          "mzss6gmiPzciFb1QrVATkr4jWfaqbYg8Hx"
        ]
      }
    },
    {
      "value": 48.9987,
      "n": 1,
      "scriptPubKey": {
        "asm": "OP_DUP OP_HASH160 25f1227565322012eba2500152cd60fd75310441 OP_EQUALVERIFY OP_CHECKSIG",
        "hex": "76a91425f1227565322012eba2500152cd60fd7531044188ac",
        "reqSigs": 1,
        "type": "pubkeyhash",
        "addresses": [
          "miyaAUfNvb6ShdXxzfPuvD4TXxXPi2eM9U"
        ]
      }
    }
  ],
  "blockhash": "65de47df79ee1b9573633c642166a59ca88d98b5ac41e1d2591a558660055cea",
  "confirmations": 6,
  "time": 1483768690,
  "blocktime": 1483768690
}
*/
console.log(JSON.stringify(n3.getTransactionS(payment2txid, true), false, '  '));
/*
{
  "hex": "020000000126a5843cf1719a0d0e5829299617b99b912cad56f8aab590e791e10bd34cba04010000006a47304402206b9ae7aeefe1ed57068dd5d7d18425299368c1bdda3806e751b87d1233431fc402201b7255b6dca19c98a9169b406bd3897a06e9604e9d273b9f4c66c1585cde4d2501210360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086fffffffff0200e1f505000000001976a914d45ec9a653a1852acd4c2173155a3cd5d25fe50e88ac30150e24010000001976a914084f392dcc9a33a3260e9918eda71db0b639183688ac00000000",
  "txid": "560f0ea66e5c16838e675394908e20befa22a2dcfa9be49f919e48e53ea3dcc6",
  "hash": "560f0ea66e5c16838e675394908e20befa22a2dcfa9be49f919e48e53ea3dcc6",
  "size": 225,
  "vsize": 225,
  "version": 2,
  "locktime": 0,
  "vin": [
    {
      "txid": "04ba4cd30be191e790b5aaf856ad2c919bb917962929580e0d9a71f13c84a526",
      "vout": 1,
      "scriptSig": {
        "asm": "304402206b9ae7aeefe1ed57068dd5d7d18425299368c1bdda3806e751b87d1233431fc402201b7255b6dca19c98a9169b406bd3897a06e9604e9d273b9f4c66c1585cde4d25[ALL] 0360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086f",
        "hex": "47304402206b9ae7aeefe1ed57068dd5d7d18425299368c1bdda3806e751b87d1233431fc402201b7255b6dca19c98a9169b406bd3897a06e9604e9d273b9f4c66c1585cde4d2501210360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086f"
      },
      "sequence": 4294967295
    }
  ],
  "vout": [
    {
      "value": 1,
      "n": 0,
      "scriptPubKey": {
        "asm": "OP_DUP OP_HASH160 d45ec9a653a1852acd4c2173155a3cd5d25fe50e OP_EQUALVERIFY OP_CHECKSIG",
        "hex": "76a914d45ec9a653a1852acd4c2173155a3cd5d25fe50e88ac",
        "reqSigs": 1,
        "type": "pubkeyhash",
        "addresses": [
          "mzss6gmiPzciFb1QrVATkr4jWfaqbYg8Hx"
        ]
      }
    },
    {
      "value": 48.9987,
      "n": 1,
      "scriptPubKey": {
        "asm": "OP_DUP OP_HASH160 084f392dcc9a33a3260e9918eda71db0b6391836 OP_EQUALVERIFY OP_CHECKSIG",
        "hex": "76a914084f392dcc9a33a3260e9918eda71db0b639183688ac",
        "reqSigs": 1,
        "type": "pubkeyhash",
        "addresses": [
          "mgGtc88yZi4ERfMuaeNYZsvYBeQy2uA5v8"
        ]
      }
    }
  ],
  "blockhash": "14eef3f0c6617077d97b3ef6eb0616bbafee224a71d3fc9442355328696d2e58",
  "confirmations": 6,
  "time": 1483768716,
  "blocktime": 1483768716
}
*/
```

The change address (`vout[1]` in both cases) differs, since the UTXO was spent from separate nodes. This could be fixed to go to the same change address both times, if one so desired. Beyond this, the two transactions do the exact same thing. Only their signatures differ. To the block chain, they are principally identical. One will be discarded in favor of the other, depending on which transaction goes into a valid block first (sans reorgs). Let's look at them in the `details=false` mode as well:

```javascript
// console.log(JSON.stringify(n1.getTransactionS(payment1txid), false, '  '));
{
  "amount": 1,
  "confirmations": 6,
  "blockhash": "65de47df79ee1b9573633c642166a59ca88d98b5ac41e1d2591a558660055cea",
  "blockindex": 1,
  "blocktime": 1483768690,
  "txid": "4fa0d47ca775b2b300a02a16a6f7ce51b880f8e0c896b490c81fa69196207170",
  "walletconflicts": [],
  "time": 1483768646,
  "timereceived": 1483768646,
  "bip125-replaceable": "no",
  "details": [
    {
      "account": "",
      "address": "mzss6gmiPzciFb1QrVATkr4jWfaqbYg8Hx",
      "category": "receive",
      "amount": 1,
      "label": "",
      "vout": 0
    }
  ],
  "hex": "020000000126a5843cf1719a0d0e5829299617b99b912cad56f8aab590e791e10bd34cba040100000069463043021f15fc82b830c60564f7e652f60a2b88253640312c5eae92425c18e85ec4507e022063831644be2c194d10752dcd847f3b9212e7d58e66483622bfe9578d2546129001210360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086fffffffff0200e1f505000000001976a914d45ec9a653a1852acd4c2173155a3cd5d25fe50e88ac30150e24010000001976a91425f1227565322012eba2500152cd60fd7531044188ac00000000"
}
// console.log(JSON.stringify(n3.getTransactionS(payment2txid), false, '  '));
{
  "amount": -1,
  "fee": -0.0012164,
  "confirmations": 6,
  "blockhash": "14eef3f0c6617077d97b3ef6eb0616bbafee224a71d3fc9442355328696d2e58",
  "blockindex": 1,
  "blocktime": 1483768716,
  "txid": "560f0ea66e5c16838e675394908e20befa22a2dcfa9be49f919e48e53ea3dcc6",
  "walletconflicts": [],
  "time": 1483768702,
  "timereceived": 1483768702,
  "bip125-replaceable": "no",
  "details": [
    {
      "account": "",
      "address": "mzss6gmiPzciFb1QrVATkr4jWfaqbYg8Hx",
      "category": "send",
      "amount": -1,
      "vout": 0,
      "fee": -0.0012164,
      "abandoned": false
    },
    {
      "account": "",
      "address": "mgGtc88yZi4ERfMuaeNYZsvYBeQy2uA5v8",
      "category": "send",
      "amount": -48.9987,
      "label": "",
      "vout": 1,
      "fee": -0.0012164,
      "abandoned": false
    },
    {
      "account": "",
      "address": "mgGtc88yZi4ERfMuaeNYZsvYBeQy2uA5v8",
      "category": "receive",
      "amount": 48.9987,
      "label": "",
      "vout": 1
    }
  ],
  "hex": "020000000126a5843cf1719a0d0e5829299617b99b912cad56f8aab590e791e10bd34cba04010000006a47304402206b9ae7aeefe1ed57068dd5d7d18425299368c1bdda3806e751b87d1233431fc402201b7255b6dca19c98a9169b406bd3897a06e9604e9d273b9f4c66c1585cde4d2501210360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086fffffffff0200e1f505000000001976a914d45ec9a653a1852acd4c2173155a3cd5d25fe50e88ac30150e24010000001976a914084f392dcc9a33a3260e9918eda71db0b639183688ac00000000"
}
```

Note that the second output is as seen from the sender `n3`, because `n1` has not seen this transaction yet (we still haven't merged the networks).

In either case, `n1` now thinks it has received 1 BTC. A naïve invoice system would note the transaction id and amount and add it to its system and then forget about the transaction.

```javascript
// Step 5
net.mergeS(nodes);
n3.generateBlocksS(1);
n1.waitForTransactionS(payment2txid);
console.log(`first payment according to n1: ${JSON.stringify(n1.getTransactionS(payment1txid), false, '  ')}`);
/*
first payment according to n1: {
  "amount": 1,
  "confirmations": -7,
  "trusted": false,
  "txid": "4fa0d47ca775b2b300a02a16a6f7ce51b880f8e0c896b490c81fa69196207170",
  "walletconflicts": [
    "560f0ea66e5c16838e675394908e20befa22a2dcfa9be49f919e48e53ea3dcc6"
  ],
  "time": 1483768646,
  "timereceived": 1483768646,
  "bip125-replaceable": "unknown",
  "details": [],
  "hex": "020000000126a5843cf1719a0d0e5829299617b99b912cad56f8aab590e791e10bd34cba040100000069463043021f15fc82b830c60564f7e652f60a2b88253640312c5eae92425c18e85ec4507e022063831644be2c194d10752dcd847f3b9212e7d58e66483622bfe9578d2546129001210360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086fffffffff0200e1f505000000001976a914d45ec9a653a1852acd4c2173155a3cd5d25fe50e88ac30150e24010000001976a91425f1227565322012eba2500152cd60fd7531044188ac00000000"
}
*/
console.log(`second payment according to n1: ${JSON.stringify(n1.getTransactionS(payment2txid), false, '  ')}`);
/*
second payment according to n1: {
  "amount": 1,
  "confirmations": 7,
  "blockhash": "14eef3f0c6617077d97b3ef6eb0616bbafee224a71d3fc9442355328696d2e58",
  "blockindex": 1,
  "blocktime": 1483768716,
  "txid": "560f0ea66e5c16838e675394908e20befa22a2dcfa9be49f919e48e53ea3dcc6",
  "walletconflicts": [
    "4fa0d47ca775b2b300a02a16a6f7ce51b880f8e0c896b490c81fa69196207170"
  ],
  "time": 1483768716,
  "timereceived": 1483768821,
  "bip125-replaceable": "no",
  "details": [
    {
      "account": "",
      "address": "mzss6gmiPzciFb1QrVATkr4jWfaqbYg8Hx",
      "category": "receive",
      "amount": 1,
      "label": "",
      "vout": 0
    }
  ],
  "hex": "020000000126a5843cf1719a0d0e5829299617b99b912cad56f8aab590e791e10bd34cba04010000006a47304402206b9ae7aeefe1ed57068dd5d7d18425299368c1bdda3806e751b87d1233431fc402201b7255b6dca19c98a9169b406bd3897a06e9604e9d273b9f4c66c1585cde4d2501210360e6082fb760e1dee6de86c9eafbbf5680be58df46eee610d7c5927b69a1086fffffffff0200e1f505000000001976a914d45ec9a653a1852acd4c2173155a3cd5d25fe50e88ac30150e24010000001976a914084f392dcc9a33a3260e9918eda71db0b639183688ac00000000"
}
*/
```

In the last example, there were wallet conflicts -- each of the two transactions were referring to each other, saying they were in conflict. This can be a helpful hint for software, but cannot be relied on, as it will not show up in the case of double spends to different destinations.
