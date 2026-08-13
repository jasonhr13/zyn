# Polar v0.0.49 Target runtime comparison

Date: 2026-08-12

## Artifact and scope

- Runtime: `/Users/jason/Downloads/polarBackend-darwin-arm64-v0.0.49`
- SHA-256: `cfefbd8ec549634bc34f20b7fdffd5692878d8cd7196fb79408fbb0a165d04c6`
- Release: `v0.0.49`, downloaded from the `PolarAIO/downloads` GitHub release selected by the Electron application.
- The runtime was inspected statically and was not executed.
- The binary was stripped and built with Garble-style symbol and literal obfuscation. Go's function table, reflection types, JSON tags, and ARM64 control flow were still recoverable.

This report compares behavior reachable in the released Target runtime with the Target Go implementation under `sites/target`. It is intended as a functional porting reference, not a verbatim source recovery.

## Executive result

Three runtime Target methods have no functional equivalent in the current source:

1. `GetOrders`
2. `FindFillerOrder`
3. `UnlockAccount`

`GetOrders` and `FindFillerOrder` form a newer order-history-based filler cancellation flow. `UnlockAccount` is invoked by a distinct `Unlock Account` task mode.

The runtime also accepts both snake-case and camel-case Target error keys. Its error model contains both `json:"error_key"` and `json:"errorKey"`; the current source only captures `error_key`. A response that supplies only `errorKey` can therefore lose its specific error classification in the current source.

Every other named, reachable Target runtime method maps to a method present in the current source. Unexported helpers are obfuscated, but their direct call graph remains inside the mapped methods; this pass found no additional unmatched top-level Target feature.

## Runtime Target method inventory

The following method names survived in the Go function table:

| Runtime method | Current source | Result |
| --- | --- | --- |
| `HandleTask` | Yes | Shared, but filler states differ |
| `HandleErrors` | Yes | Shared; runtime cancellation calls it |
| `BuildProductWebhookItems` | Yes | Shared |
| `FindFillerOrder` | No | Runtime-only and directly called |
| `GetSession` | Yes | Shared |
| `GetShape` | Yes | Shared |
| `GetLoginSession` | Yes | Shared |
| `GetAuthCodes` | Yes | Shared |
| `GetAuthRedirect` | Yes | Shared |
| `LoginOTP` | Yes | Shared |
| `Login` | Yes | Shared |
| `Get2faCode` | Yes | Shared |
| `Submit2faCode` | Yes | Shared |
| `RequestPasswordResetCode` | Yes | Shared request primitive |
| `VerifyPasswordResetCode` | Yes | Shared request primitive |
| `ResetPassword` | Yes | Shared request primitive |
| `RefreshLogin` | Yes | Shared |
| `GetCart` | Yes | Shared |
| `RemoveFromCart` | Yes | Shared |
| `GetAddresses` | Yes | Shared |
| `SetAddress` | Yes | Shared |
| `AddToCart` | Yes | Shared |
| `PrepareCheckout` | Yes | Shared |
| `SubmitPayment` | Yes | Shared |
| `SubmitOrder` | Yes | Shared, but filler tracking differs |
| `RemovePaymentMethod` | Yes | Shared |
| `CheckOrder` | Yes | Shared, but filler tracking differs |
| `RemoveFillerItem` | Yes | Same aggregation behavior |
| `GetOrders` | No | Runtime-only and directly called |
| `UnlockAccount` | No | Runtime-only and directly called by task startup |

The source also contains `ValidateToken`, `GetPayments`, `DeletePaymentCard`, and `DeleteAddress`. They are not reachable in the v0.0.49 runtime's active Target state machine; linker elimination may account for their missing runtime symbols.

## Reflection-schema comparison

A complete comparison of the runtime Target package's recoverable JSON tags against `sites/target` found these runtime fields absent from the source:

```text
errorKey
fulfillment_spec
is_cancellable
key
operations
original_quantity
placed_date
status
```

All fields except `errorKey` belong to the order-history structures described below. This provides a second, independent check that the order-history workflow and alternate camel-case error key are the schema-level additions; no other runtime-only Target API model was found.

## Recovered order-history schema

The runtime reflection metadata exposes the following JSON structure. Go identifiers below are descriptive replacements for obfuscated names.

```go
type OrderHistoryResponse struct {
	Orders []OrderHistoryEntry `json:"orders"`
}

type OrderHistoryEntry struct {
	OrderNumber string             `json:"order_number"`
	PlacedDate  string             `json:"placed_date"`
	OrderLines  []OrderHistoryLine `json:"order_lines"`
}

type OrderHistoryLine struct {
	OrderLineKey     string `json:"order_line_key"`
	OrderLineID      string `json:"order_line_id"`
	OriginalQuantity int    `json:"original_quantity"`
	Item struct {
		TCIN string `json:"tcin"`
	} `json:"item"`
	FulfillmentSpec struct {
		Status struct {
			Key        string `json:"key"`
			Operations struct {
				IsCancellable bool `json:"is_cancellable"`
			} `json:"operations"`
		} `json:"status"`
	} `json:"fulfillment_spec"`
}
```

The exact runtime endpoint was recovered as:

```text
GET https://api.target.com/guest_order_aggregations/v1/order_history?page_number=1&page_size=10&order_purchase_type=ONLINE&pending_order=true&shipt_status=true
```

`GetOrders` performs one request. On HTTP 200 it unmarshals `orders` and replaces `TargetTask.OrderHistory`. HTTP 429 has a special `DCO_RATE_LIMITED` path; other responses become ordinary task errors. Request failures invoke proxy-rotation handling.

## Recovered filler selection

Behavioral reconstruction:

```go
func (t *TargetTask) FindFillerOrder() bool {
	t.FillerNeedsRetry = false

	for _, order := range t.OrderHistory {
		for _, line := range order.OrderLines {
			if line.Item.TCIN != FillerItem {
				continue
			}

			if strings.EqualFold(line.FulfillmentSpec.Status.Key, canceledStatus) {
				t.CanceledFillerItem = true
				return false
			}

			if !line.FulfillmentSpec.Status.Operations.IsCancellable {
				t.FillerNeedsRetry = true
				return false
			}

			t.FillerOrders = []*FillerOrderState{{
				ReferenceId:  order.OrderNumber,
				ItemQty:      line.OriginalQuantity,
				OrderLineId:  line.OrderLineID,
				OrderLineKey: line.OrderLineKey,
			}}
			return true
		}
	}

	return false
}
```

The comparison against an encrypted canceled-status literal is confirmed. Its semantic meaning is canceled; the exact single-L/double-L spelling is not required if the port accepts both forms.

Important behavioral details:

- It selects the first matching filler TCIN from the returned ten-order history page.
- It does not correlate the match with a checkout reference captured by `SubmitOrder`.
- If the first matching line is not cancellable, it requests a retry immediately instead of scanning later matches.
- It overwrites `FillerOrders` with one entry rather than accumulating multiple filler orders.

## Released filler state machine

After the real order is checked successfully, the runtime performs:

1. `GetOrders()`.
2. Normal `HandleErrors("get-orders")` processing.
3. `FindFillerOrder()`.
4. If a filler line exists but is not cancellable, increment `FillerOrderRetries`, wait 3,000 ms, and repeat.
5. Stop polling after 20 attempts.
6. If a cancellable line was found, transition to `cancel-filler`.
7. Call `RemoveFillerItem()` and then `HandleErrors("cancel-filler")`.

This means request failures during cancellation remain in the error/retry loop. The current source calls `RemoveFillerItem()` but does not call `HandleErrors` in the `cancel-filler` state, so it may proceed after a failed cancellation.

## Recovered cancellation request

The runtime constructs the equivalent of:

```go
qty := max(filler.ItemQty, 1)
payload := map[string]interface{}{
	"order_lines": []map[string]interface{}{{
		"order_line_id":      filler.OrderLineId,
		"order_line_key":     filler.OrderLineKey,
		"requested_quantity": strconv.Itoa(qty),
		"reason_code":        "GUEST_CANCEL",
		"comments":           "No longer want the item",
	}},
}
```

It posts to:

```text
POST https://api.target.com/post_order_support/v1/orders/{orderNumber}/cancellations
```

Response behavior:

- HTTP 200 or 201: set `FillerOrderState.Canceled = true`; return success.
- HTTP 400 whose body contains `not eligible for cancellation`: also set `Canceled = true`; return success.
- Request failure: set a proxy error, attempt proxy rotation, and return failure.
- Other responses: record an unknown response, set `cancel-filler (<status>)`, and return failure.

## Confirmed filler hazards

These are properties of the released runtime and should not be copied blindly:

1. **Unscoped order-history selection.** The first recent order containing the filler TCIN can be selected even if it belongs to another checkout.
2. **Ambiguous HTTP 400 treated as success.** `not eligible for cancellation` does not prove the item is already canceled.
3. **Missing line ID can produce false success.** `RemoveFillerItem` skips entries with an empty `OrderLineId` while leaving `allCanceled` true.
4. **Retry exhaustion can continue without cancellation.** After 20 discovery attempts, the checkout can proceed with `CanceledFillerItem == false`.
5. **No post-cancellation verification.** A nominally successful response is not followed by an order-history status confirmation.

## Difference from the current source's filler implementation

The current source attempts to track filler order references from `SubmitOrder`, then populate order-line IDs from `CheckOrder`. That correlation is safer than the runtime's account-wide first-match search, but the source is missing the runtime's polling and error integration.

Recommended port design:

1. Preserve reference IDs captured from `SubmitOrder`.
2. Poll order history as a fallback for those specific order numbers only.
3. Retry discovery up to 20 times with a three-second delay, or use an equivalent context-bound policy.
4. Route cancellation failure through `HandleErrors`.
5. Make an empty `OrderLineId` a failure, not a skipped success.
6. Treat the ambiguous HTTP 400 as pending/unknown and refresh order history.
7. Mark cancellation successful only after a success response or a refreshed canceled status.

## Runtime-only Unlock Account mode

The startup routine contains an exact comparison for the task mode:

```text
Unlock Account
```

When selected, it calls `TargetTask.UnlockAccount()` instead of `HandleTask()`.

The recovered direct call sequence shows that `UnlockAccount` orchestrates existing request primitives:

1. Validate required account input and initialize a session.
2. `GetSession()` and normal error handling.
3. Acquire Target shape data with `GetShape()`.
4. Start the login/reset session using `GetLoginSession()`.
5. `RequestPasswordResetCode()`.
6. Wait for an email code under a timeout.
7. Refresh shape/proxy state as required.
8. `VerifyPasswordResetCode()`.
9. `ResetPassword()`.
10. Invoke the account-password persistence/update routine.
11. Stop with a terminal success or error status.

The current source contains the three reset request methods and IMAP code-waiting support, but it has no active `Unlock Account` startup mode and no equivalent orchestration method. Some older password-reset cases remain commented out in `HandleTask`.

## Confidence

| Finding | Confidence |
| --- | --- |
| Runtime-only method inventory | 98% |
| `Unlock Account` mode and direct orchestration calls | 95% |
| Order-history endpoint and JSON schema | 98% |
| Filler selection control flow | 97% |
| 20 retries with 3-second delay | 99% |
| Cancellation request and 200/201 behavior | 95% |
| HTTP 400 substring and success branch | 97% |
| Exact original identifier names/formatting | Not relevant to porting |

Overall confidence that the recovered filler behavior is sufficient for a correct, safer Go port is 90-95%. Live Target response fixtures are still required because the external API and account state are not represented by static analysis.
