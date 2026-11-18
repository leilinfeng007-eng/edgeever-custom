import { enUS as sharedCatalog } from "@edgeever/shared/i18n/en-US";

export const enUS = {
  ...sharedCatalog,
  inboxClassification: {
    title: "Automatic filing", selectNote: "Select a note to check filing status", loading: "Checking filing status", statusFailed: "Unable to check filing status",
    idle: "Filing has not started", pending: "Queued for filing", running: "Finding a notebook", moved: "Filed in {{name}}",
    suggested: "Suggested notebook: {{name}}", retained: "Kept in the inbox", apply: "Apply suggestion", start: "File this note",
    retry: "Retry filing", undo: "Move back to inbox", actionFailed: "Action failed. Refresh and try again.",
    outcomes: {
      invalid_model_response: "The model returned an invalid response. You can retry.",
      model_empty_output: "The model returned no content", model_truncated: "The model response was cut off",
      model_json_invalid: "The response could not be parsed", model_fields_invalid: "The model returned invalid fields or a destination",
      model_auth_failed: "Model service authentication failed", model_request_rejected: "The model service rejected the request",
      model_not_configured: "EdgeEver has no default model", classification_failed: "The model request failed or timed out",
      no_destination: "No destination notebooks are available", invalid_destination: "The suggested notebook is unavailable",
      empty_body: "Add some text before filing this note", unclear: "No clear destination",
      source_updated: "This note was updated during filing", source_changed: "This note changed", source_or_destination_changed: "The note or destination changed",
      review_recommended: "The suggestion is stale. Try filing again.", undone: "Moved back to the inbox",
    },
  },
  attachmentText: {
    action: "View attachment text", loading: "Reading attachment", next: "Load more text", empty: "No text could be extracted", failed: "Unable to read the attachment.",
    errors: { attachment_format_unsupported: "This format has no text preview.", attachment_too_large: "The attachment exceeds the preview size limit.",
      attachment_invalid_docx: "The Word file is damaged or encrypted.", attachment_invalid_text: "The attachment is not UTF-8 text." },
  },
} as const;
