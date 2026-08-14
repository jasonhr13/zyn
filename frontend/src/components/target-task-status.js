const textOf = (status) => [...new Set([
  (status && status.label) || '',
  status && typeof status.state === 'string' ? status.state : '',
].map(value => String(value).trim().toLowerCase()).filter(Boolean))].join(' ');

// Runtime liveness and visual phase are deliberately separate. A retriable red error can still be
// running, and a looping task remains running during its brief Successful status.
export function targetTaskIsRunning(status) {
  if (!status) return false;
  if (status.running === true) return true;
  if (status.running === false) return false;
  const text = textOf(status);
  if (/^(?:idle|stopped|(?:task )?limit reached)$/.test(text)) return false;
  if (/^(?:product found:|rotated profile to:|switch(?:ed)? to|throttled - switched to)/.test(text)) return true;
  return !!text && !/\b(?:successful|checked out|payment declined)\b/.test(text);
}

export function targetStatusTone(status) {
  if (!status) return 'idle';
  const text = textOf(status);
  const taskState = Number(status.taskState);
  const color = String(status.color || '').trim().toLowerCase();

  if (taskState === 3) return 'success';
  if (taskState === 4) return 'error';

  // Dynamic names follow these prefixes. Classify the operation before scanning their content so
  // a product/profile/proxy named “Successful”, “Stopped”, or “Waiting For Restock” cannot change
  // the task's phase.
  if (/^could not (?:switch|clear)/.test(text)) return 'error';
  if (/^product found:/.test(text)) return 'carting';
  if (/^rotated profile to:/.test(text)
    || /^(?:switch(?:ed)? to|throttled - switched to)\b/.test(text)) return 'submitting';

  // These confirmation states are intentionally green before the final status arrives, making it
  // obvious at a glance that the task is waiting on Target rather than still building the order.
  if (/\b(?:success(?:ful)?|checked out|waiting for order|getting order status|order not finished processing|removing filler item)\b/.test(text)) {
    return 'success';
  }

  // Known restock phrases override the engine's raw color (Out Of Stock is emitted as red even
  // though it is the normal steady state for a monitor).
  if (/(?:waiting for restock|watching for restock|getting product(?:s|\(s\))?|monitoring products?)/.test(text)
    || /^out of stock$/.test(text)) {
    return 'watching';
  }

  // Prefixes are checked before generic error words so a product name containing “error” or
  // “blocked” cannot turn a healthy Product Found status red.
  if (/^product in stock\b/.test(text)
    || /\b(?:adding to cart|carting filler item|getting cart(?! info)|using alternate cart flow)\b/.test(text)
    || /^limit reached$/.test(text)) {
    return 'carting';
  }

  if (/\b(?:error|fail(?:ed|ure)?|declin(?:e|ed)|cancelled|canceled|blocked|could not|invalid|invaild|timed out|rate[ -]?limited|ratelimited|no valid tcin|product not found|bad session|locked)\b/.test(text)) {
    return 'error';
  }

  // Once Target has accepted an item into the cart, use a dedicated order-submission tone. These
  // steps used to share the blue setup/Shape color, which made the most important phase invisible
  // when scanning a large task group.
  if (/\b(?:carted|get(?:ting)? cart info|preparing checkout|setting address|setting payment|submitting payment|submitting cvv|submitting order|out of stock, checking cart|rotating profile|throttled|finishing on home ip)\b/.test(text)) {
    return 'submitting';
  }

  if (/\b(?:preparing runtime|starting(?: task)?|completed task init|getting session|logging in|login|requesting login code|waiting for code|submitting code|validating login|getting details|setting details|waiting for shape|rotating proxy|setting proxy|proxy updated)\b/.test(text)) {
    return 'checkout';
  }

  if (color === '#fb5454' || color === '#ff5a5a') return 'error';
  return targetTaskIsRunning(status) ? 'checkout' : 'idle';
}
