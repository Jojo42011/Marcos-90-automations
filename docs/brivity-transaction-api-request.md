# Brivity transaction API access

The repository implements Brivity People access plus CSV transaction import and optional sheet synchronization. It has no native Brivity transaction API client. This is a support-request template, not a statement about current Brivity API availability or credentials.

## Draft request

Subject: Transaction API or webhook access

We maintain a real estate operations dashboard and want to synchronize transaction data. Our repository currently supports contact access through the People API and transaction ingestion through CSV or a configured sheet.

Could you confirm:

1. Whether our account can access a transaction/pipeline endpoint, including its base URL, version and required scopes.
2. Whether transaction-created, status-changed and closed events are available through signed webhooks.
3. Whether another API tier or report-export API is required.

Desired fields include property address, transaction side, status, MLS number, assigned agent, list/sale price, gross commission and list/contract/close dates.

Please provide the current API documentation and account-enablement requirements. We will supply sanitized diagnostics separately if needed.

## Implementation boundary

No request is sent by this document. Do not include API keys in support messages.

A future API/webhook implementation must follow the current account-routing boundary and map into src/core/transactionImport.ts / src/core/transactionsStore.ts. Do not label CSV-derived data live until an actual synchronization path and freshness checks exist. The existing import path remains available.
