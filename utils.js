const deasync = require('deasync');

Array.prototype.removeOneByValue = function(v) {
    for (let i = this.length - 1; i >= 0; i--)
        if (this[i] === v)
            return this.splice(i, 1);
    return this;
};

const Barrier = function() {
    this.counter = 0;
};

const DeasyncObject = (object, synchronousByNature = []) => {
    for (const m of Object.keys(object.prototype)) {
      if (!synchronousByNature[m])
        object.prototype[`${m}S`] = deasync(object.prototype[m]);
    }
};

Barrier.prototype = {
    tick() {
        this.counter++;
        return (err) => {
            this.counter--;
            if (err) this.err = err;
            if (this.counter === 0 && this.endCallback) this.endCallback(err);
        };
    },
    wait(endcb) {
        this.endCallback = endcb;
        if (this.counter === 0) endcb(this.err);
    },
    clear() {
        this.endCallback = null;
        this.err = null;
    },
};

module.exports = {
    Barrier,
    DeasyncObject,
};
