"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildInboundMondayUpdateValues,
  KeyedSerialQueue,
  mergeNonBlankState,
  mondayDateValue,
  persistLatestSession,
  retryTransientOperation,
  validateMondayEnvelope
} = require("../inbound-persistence");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("delayed item creation writes values collected while creation is pending", async () => {
  const gate = deferred();
  let session = { call_id: "call-1", phone: "+15551234567" };
  let sentPayload = null;
  const pending = persistLatestSession({
    callId: "call-1",
    loadSession: async () => session,
    ensureItem: async () => {
      await gate.promise;
      session = { ...session, monday_item_id: "item-1" };
    },
    buildPayload: async (latest) => ({ ...latest }),
    updateItem: async (_itemId, payload) => {
      sentPayload = payload;
      return { id: "item-1" };
    }
  });
  session = mergeNonBlankState(session, {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane@example.com",
    credit_score: "690",
    tax_return_status: "2 Years Filed"
  });
  gate.resolve();
  await pending;
  assert.equal(sentPayload.first_name, "Jane");
  assert.equal(sentPayload.last_name, "Doe");
  assert.equal(sentPayload.email, "jane@example.com");
  assert.equal(sentPayload.credit_score, "690");
  assert.equal(sentPayload.tax_return_status, "2 Years Filed");
});

test("a transient update failure retries and keeps the same payload", async () => {
  let attempts = 0;
  const payload = { first_name: "Jane", credit_score: "690" };
  const result = await retryTransientOperation(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("temporary outage");
        error.httpStatus = 503;
        throw error;
      }
      return payload;
    },
    { sleep: async () => undefined }
  );
  assert.equal(attempts, 2);
  assert.deepEqual(result, payload);
});

test("disconnect persistence waits for the final queued answer", async () => {
  const queue = new KeyedSerialQueue();
  const answerGate = deferred();
  let session = { call_id: "call-3", monday_item_id: "item-3" };
  const answerSave = queue.run("call-3", async () => {
    await answerGate.promise;
    session = mergeNonBlankState(session, { tax_return_status: "2 Years Filed" });
  });
  let finalPayload = null;
  const disconnectSave = persistLatestSession({
    callId: "call-3",
    queue,
    loadSession: async () => session,
    ensureItem: async () => undefined,
    buildPayload: async (latest) => ({ ...latest }),
    updateItem: async (_itemId, payload) => {
      finalPayload = payload;
      return { id: "item-3" };
    }
  });
  answerGate.resolve();
  await Promise.all([answerSave, disconnectSave]);
  assert.equal(finalPayload.tax_return_status, "2 Years Filed");
});

test("two disconnect saves reuse one Monday item", async () => {
  const queue = new KeyedSerialQueue();
  let creates = 0;
  let updates = 0;
  let session = { call_id: "call-4" };
  const options = {
    callId: "call-4",
    queue,
    loadSession: async () => session,
    ensureItem: async () => {
      creates += 1;
      session = { ...session, monday_item_id: "item-4" };
    },
    buildPayload: async (latest) => ({ ...latest }),
    updateItem: async () => {
      updates += 1;
      return { id: "item-4" };
    }
  };
  await Promise.all([
    persistLatestSession(options),
    persistLatestSession(options)
  ]);
  assert.equal(creates, 1);
  assert.equal(updates, 2);
  assert.equal(session.monday_item_id, "item-4");
});

test("blank partial values do not erase durable nonblank values", () => {
  const current = {
    first_name: "Jane",
    last_name: "Doe",
    email: "jane@example.com"
  };
  const merged = mergeNonBlankState(current, {
    first_name: "",
    last_name: null,
    email: undefined,
    credit_score: "690"
  });
  assert.deepEqual(merged, { ...current, credit_score: "690" });
});

test("HTTP 200 GraphQL errors are failures", () => {
  assert.throws(
    () =>
      validateMondayEnvelope(200, {
        data: { change_multiple_column_values: null },
        errors: [{ message: "Invalid column value" }]
      }),
    (error) =>
      /GraphQL error/.test(error.message) &&
      error.httpStatus === 200 &&
      error.mondayErrors.length === 1
  );
});

test("local follow-up date and time are not shifted through UTC", () => {
  assert.deepEqual(
    mondayDateValue("2026-08-02", "09:30"),
    { date: "2026-08-02", time: "09:30:00" }
  );
});

test("serialized saves prevent an older async save from winning", async () => {
  const queue = new KeyedSerialQueue();
  const olderGate = deferred();
  let session = { first_name: "Jane" };
  const older = queue.run("call-8", async () => {
    await olderGate.promise;
    session = mergeNonBlankState(session, { email: "old@example.com" });
  });
  const newer = queue.run("call-8", async () => {
    session = mergeNonBlankState(session, { email: "new@example.com" });
  });
  olderGate.resolve();
  await Promise.all([older, newer]);
  assert.equal(session.email, "new@example.com");
});

test("a complete inbound session produces every supported final field", async () => {
  const session = {
    call_id: "call-9",
    monday_item_id: "item-9",
    first_name: "Jane",
    last_name: "Doe",
    full_name: "Jane Doe",
    phone: "+15551234567",
    email: "jane@example.com",
    credit_score: "690",
    tax_return_status: "2 Years Filed",
    caller_type: "Inbound Call",
    summary: "Caller asked about eligibility and received readiness guidance.",
    date_called: "2026-07-27",
    next_follow_up: "2026-08-02",
    follow_up_time: "09:30",
    follow_up_timezone: "America/New_York",
    call_status: "completed"
  };
  const persisted = await persistLatestSession({
    callId: session.call_id,
    loadSession: async () => session,
    ensureItem: async () => undefined,
    buildPayload: async (latest) => ({ ...latest }),
    updateItem: async (_itemId, payload) => ({ id: "item-9", payload })
  });
  for (const field of [
    "first_name",
    "last_name",
    "full_name",
    "phone",
    "email",
    "credit_score",
    "tax_return_status",
    "caller_type",
    "summary",
    "date_called",
    "next_follow_up",
    "follow_up_time",
    "follow_up_timezone",
    "call_status"
  ]) {
    assert.ok(persisted.payload[field], `${field} should be present`);
  }
});

test("real inbound mapping uses Monday text, email, status, date, and long-text formats", () => {
  const columns = {
    firstName: "text_mm5fx7z9",
    lastName: "text_mm5ffrc0",
    email: "email_mm5f7560",
    creditScore: "text_mm5j48bj",
    taxReturnStatus: "text_mm5jx81q",
    summary: "text_mm5fsx2c",
    callerType: "color_mm5es680",
    nextFollowUp: "date_mm5ew2hf"
  };
  const metadata = {
    columns: [
      { id: columns.firstName, type: "text" },
      { id: columns.lastName, type: "text" },
      { id: columns.email, type: "email" },
      { id: columns.creditScore, type: "text" },
      { id: columns.taxReturnStatus, type: "text" },
      { id: columns.summary, type: "text" },
      {
        id: columns.callerType,
        type: "color",
        settings: {
          labels: [{ id: 7, label: "Inbound Call", index: 0 }]
        }
      },
      { id: columns.nextFollowUp, type: "date" }
    ]
  };
  const values = buildInboundMondayUpdateValues({
    data: {
      first_name: "Jane",
      last_name: "Doe",
      email: "jane@example.com",
      credit_score: "690",
      tax_return_status: "2 Years Filed",
      summary: "Detailed call summary",
      caller_type: "Inbound Call",
      next_follow_up: "2026-08-02",
      follow_up_time: "09:30"
    },
    columns,
    metadata
  });
  assert.deepEqual(values, {
    text_mm5fx7z9: "Jane",
    text_mm5ffrc0: "Doe",
    text_mm5j48bj: "690",
    text_mm5jx81q: "2 Years Filed",
    email_mm5f7560: {
      email: "jane@example.com",
      text: "jane@example.com"
    },
    text_mm5fsx2c: "Detailed call summary",
    color_mm5es680: { index: 7 },
    date_mm5ew2hf: {
      date: "2026-08-02",
      time: "09:30:00"
    }
  });
  assert.equal(
    JSON.stringify(values),
    JSON.stringify(JSON.parse(JSON.stringify(values)))
  );
  const longTextValues = buildInboundMondayUpdateValues({
    data: { summary: "Detailed call summary" },
    columns,
    metadata: {
      columns: metadata.columns.map((column) =>
        column.id === columns.summary
          ? { ...column, type: "long_text" }
          : column
      )
    }
  });
  assert.deepEqual(longTextValues, {
    text_mm5fsx2c: { text: "Detailed call summary" }
  });
});
