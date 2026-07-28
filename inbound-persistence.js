"use strict";

function meaningfulValue(value) {
  if (value === undefined || value === null) return false;
  return typeof value !== "string" || value.trim() !== "";
}

function mergeNonBlankState(current = {}, patch = {}) {
  return {
    ...(current && typeof current === "object" ? current : {}),
    ...Object.fromEntries(
      Object.entries(patch && typeof patch === "object" ? patch : {})
        .filter(([, value]) => meaningfulValue(value))
    )
  };
}

class KeyedSerialQueue {
  constructor() {
    this.chains = new Map();
  }

  run(key, task) {
    const queueKey = String(key || "");
    if (!queueKey) return Promise.reject(new Error("A queue key is required."));
    const previous = this.chains.get(queueKey) || Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(task);
    this.chains.set(queueKey, pending);
    return pending.finally(() => {
      if (this.chains.get(queueKey) === pending) {
        this.chains.delete(queueKey);
      }
    });
  }

  pending(key) {
    return this.chains.get(String(key || "")) || null;
  }

  values() {
    return this.chains.values();
  }
}

function mondayFailure(message, properties = {}) {
  const error = new Error(message);
  Object.assign(error, properties);
  return error;
}

function validateMondayEnvelope(status, body) {
  const httpStatus = Number(status || 0);
  if (httpStatus < 200 || httpStatus >= 300) {
    throw mondayFailure(`monday.com HTTP ${httpStatus}`, {
      httpStatus,
      mondayErrors: Array.isArray(body?.errors) ? body.errors : null
    });
  }
  if (Array.isArray(body?.errors) && body.errors.length) {
    throw mondayFailure(
      `monday.com GraphQL error: ${body.errors
        .map((entry) => String(entry?.message || "Unknown monday.com error"))
        .join(" | ")}`,
      { httpStatus, mondayErrors: body.errors }
    );
  }
  return body?.data || {};
}

function transientMondayFailure(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  if (
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"]
      .includes(error.code)
  ) {
    return true;
  }
  const status = Number(error.httpStatus || 0);
  if (status === 429 || status >= 500) return true;
  const messages = (error.mondayErrors || [])
    .map((entry) => String(entry?.message || ""))
    .join(" ")
    .toLowerCase();
  return /temporar|timeout|timed out|rate limit|too many|internal|unavailable|try again/.test(
    messages
  );
}

async function retryTransientOperation(
  operation,
  {
    maxAttempts = 3,
    backoffMs = [0, 500, 1500],
    isTransient = transientMondayFailure,
    onAttemptFailure = null,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds))
  } = {}
) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts || 1));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const retryable = isTransient(error);
      if (onAttemptFailure) {
        await onAttemptFailure({ attempt, maxAttempts: attempts, retryable, error });
      }
      if (!retryable || attempt >= attempts) throw error;
      const delay = Number(backoffMs[attempt] ?? backoffMs.at(-1) ?? 0);
      if (delay > 0) await sleep(delay);
    }
  }
  throw lastError || new Error("The monday.com operation failed.");
}

function normalizeLocalDate(value) {
  const cleaned = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) return null;
  const [year, month, day] = cleaned.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? cleaned
    : null;
}

function normalizeLocalTime(value) {
  const cleaned = String(value || "").trim().toLowerCase();
  const match = cleaned.match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/
  );
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = match[4] || null;
  if (
    minute > 59 ||
    second > 59 ||
    (meridiem ? hour < 1 || hour > 12 : hour > 23)
  ) {
    return null;
  }
  if (meridiem === "am" && hour === 12) hour = 0;
  if (meridiem === "pm" && hour !== 12) hour += 12;
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function mondayDateValue(localDate, localTime) {
  const date = normalizeLocalDate(localDate);
  if (!date) return null;
  const time = normalizeLocalTime(localTime);
  return time ? { date, time } : { date };
}

function mondayColumnById(metadata, columnId) {
  return metadata?.columns?.find((column) => column.id === columnId) || null;
}

function requireMondayColumn(metadata, columnId, expectedTypes) {
  const column = mondayColumnById(metadata, columnId);
  if (!column) {
    throw new Error(`monday.com column ${columnId} was not found on the live board.`);
  }
  const type = String(column.type || "").toLowerCase();
  if (!expectedTypes.includes(type)) {
    throw new Error(
      `monday.com column ${columnId} has type ${type || "unknown"}; expected ${expectedTypes.join(" or ")}.`
    );
  }
  return column;
}

function mondayStatusValue(column, desiredLabel) {
  const desired = String(desiredLabel || "").trim().toLowerCase();
  const labels = column?.settings?.labels;
  const entries = Array.isArray(labels)
    ? labels.map((entry) => [null, entry])
    : Object.entries(labels || {});
  const match = entries.find(([, entry]) => {
    const label = typeof entry === "string"
      ? entry
      : entry?.label || entry?.name;
    return String(label || "").trim().toLowerCase() === desired;
  });
  if (!match) {
    throw new Error(
      `monday.com status column ${column?.id || "unknown"} does not contain label ${desiredLabel}.`
    );
  }
  const [key, entry] = match;
  const id = typeof entry === "object"
    ? entry?.id ?? entry?.index ?? key
    : key;
  const numericId = Number(id);
  return Number.isInteger(numericId)
    ? { index: numericId }
    : { label: typeof entry === "string" ? entry : entry.label || entry.name };
}

function buildInboundMondayUpdateValues({
  data = {},
  columns,
  metadata
}) {
  const values = {};
  const textFields = [
    ["first_name", columns.firstName],
    ["last_name", columns.lastName],
    ["credit_score", columns.creditScore],
    ["tax_return_status", columns.taxReturnStatus]
  ];
  for (const [field, columnId] of textFields) {
    if (!meaningfulValue(data[field])) continue;
    requireMondayColumn(metadata, columnId, ["text"]);
    values[columnId] = String(data[field]).trim();
  }
  if (meaningfulValue(data.email)) {
    requireMondayColumn(metadata, columns.email, ["email"]);
    const email = String(data.email).trim();
    values[columns.email] = { email, text: email };
  }
  if (meaningfulValue(data.summary)) {
    const column = requireMondayColumn(
      metadata,
      columns.summary,
      ["text", "long_text"]
    );
    const summary = String(data.summary).trim();
    values[columns.summary] =
      String(column.type).toLowerCase() === "long_text"
        ? { text: summary }
        : summary;
  }
  if (meaningfulValue(data.caller_type)) {
    const column = requireMondayColumn(
      metadata,
      columns.callerType,
      ["color", "status"]
    );
    values[columns.callerType] = mondayStatusValue(
      column,
      String(data.caller_type).trim()
    );
  }
  if (meaningfulValue(data.next_follow_up)) {
    requireMondayColumn(metadata, columns.nextFollowUp, ["date"]);
    const dateValue = mondayDateValue(
      data.next_follow_up,
      data.follow_up_time
    );
    if (!dateValue) {
      throw new Error("The monday.com Next Follow-Up date or time is invalid.");
    }
    values[columns.nextFollowUp] = dateValue;
  }
  return values;
}

async function persistLatestSession({
  callId,
  queue,
  alreadySerialized = false,
  loadSession,
  ensureItem,
  itemIdFromSession = (session) => session?.monday_item_id,
  buildPayload,
  updateItem
}) {
  const key = String(callId || "");
  if (!key) throw new Error("A call ID is required.");
  const persist = async () => {
    let session = await loadSession(key);
    if (!session) throw new Error("The call session was not found.");
    let itemId = itemIdFromSession(session);
    if (!itemId) {
      await ensureItem(session);
      session = await loadSession(key);
      if (!session) throw new Error("The call session was not found.");
      itemId = itemIdFromSession(session);
    }
    if (!itemId) throw new Error("The monday.com item ID is unavailable.");
    const payload = await buildPayload(session);
    const result = await updateItem(itemId, payload, session);
    return { session, itemId: String(itemId), payload, result };
  };
  if (alreadySerialized || !queue) return persist();
  return queue.run(key, persist);
}

module.exports = {
  KeyedSerialQueue,
  buildInboundMondayUpdateValues,
  meaningfulValue,
  mergeNonBlankState,
  mondayDateValue,
  normalizeLocalDate,
  normalizeLocalTime,
  persistLatestSession,
  retryTransientOperation,
  transientMondayFailure,
  validateMondayEnvelope
};
