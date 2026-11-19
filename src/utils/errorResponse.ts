import { HttpStatus } from '@api/routes/index.router';

export interface MetaErrorResponse {
  status: number;
  error: string;
  message: string;
  details: {
    whatsapp_error: string;
    whatsapp_code: string | number;
    error_user_title: string;
    error_user_msg: string;
    error_type: string;
    error_subcode: number | null;
    fbtrace_id: string | null;
    context: string;
    type: string;
  };
  timestamp: string;
}

/**
 * Creates standardized error response for Meta/WhatsApp API errors
 */
export function createMetaErrorResponse(error: any, context: string): MetaErrorResponse {
  // Extract Meta/WhatsApp specific error fields
  const metaError = error.template || error;
  const errorUserTitle = metaError.error_user_title || metaError.message || 'Unknown error';
  const errorUserMsg = metaError.error_user_msg || metaError.message || 'Unknown error';

  return {
    status: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    message: errorUserTitle,
    details: {
      whatsapp_error: errorUserMsg,
      whatsapp_code: metaError.code || 'UNKNOWN_ERROR',
      error_user_title: errorUserTitle,
      error_user_msg: errorUserMsg,
      error_type: metaError.type || 'UNKNOWN',
      error_subcode: metaError.error_subcode || null,
      fbtrace_id: metaError.fbtrace_id || null,
      context,
      type: 'whatsapp_api_error',
    },
    timestamp: new Date().toISOString(),
  };
}
