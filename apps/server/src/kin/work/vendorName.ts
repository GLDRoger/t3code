const DOCUMENT_WORD =
  /^(?:tax\s+)?(?:receipts?|invoices?|bills?|statements?)(?:\s*(?:no\.?|number|#)?\s*[\w\-/]*\d[\w\-/]*)?$/i;
const FILE_NAME =
  /\.(?:jpe?g|png|gif|heic|heif|webp|tiff?|bmp|pdf|docx?|xlsx?|csv|txt)$|^(?:img|dsc|pxl|scan|screenshot)[\s_-]*\d/i;

/** A word a document calls itself, or a file's name: what a receipt was, never who was paid. */
export const notAVendor = (vendor: string) => {
  const said = vendor.trim();
  return DOCUMENT_WORD.test(said) || FILE_NAME.test(said);
};
