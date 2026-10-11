'use strict';
// Receipt numbers are "last + 1", read outside any lock, and
// (churchId, receiptNumber) is unique. Two cashiers recording in the same
// moment therefore pick the same number; the loser's insert hits the unique
// index. Retry with a fresh number rather than failing a request whose money
// has already been posted. Safe outside a transaction: a unique violation only
// aborts a transaction, and none is open here.

async function createReceipt(db, nextNo, data, attempts = 5) {
  let number = data.receiptNumber;
  for (let i = 0; ; i++) {
    try {
      return await db.financeReceipt.create({ data: { ...data, receiptNumber: number } });
    } catch (e) {
      if (e.code !== 'P2002' || i >= attempts - 1) throw e;
      number = await nextNo();
    }
  }
}

// A pledge payment's receipt number is derived from its own id, so it can only
// be written after the row exists. Inserting every payment with receiptNumber ''
// collided on the (churchId, receiptNumber) unique index whenever two payments
// were recorded at once (the second insert failed with a 500). Use a unique
// placeholder that is replaced immediately.
const crypto = require('crypto');
const pendingReceiptNo = () => `PENDING-${crypto.randomBytes(8).toString('hex')}`;

module.exports = { createReceipt, pendingReceiptNo };
