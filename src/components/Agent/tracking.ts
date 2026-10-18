/**
 * Blue Dart tracking → our shipmentStatus.
 *
 * Failure / exception statuses are checked FIRST so that e.g. "UNDELIVERED",
 * "RTO IN TRANSIT" or "SHIPMENT NOT PICKED" can never be read as delivered or
 * in transit just because they contain "DELIVERED" / "TRANSIT" / "PICKED".
 * Only exact delivered statuses map to "Product Reached".
 */
export type TrackedShipmentStatus = 'Product Reached' | 'In Transit' | 'Pickup Scheduled' | 'Pickup Exception' | 'Failed';

const DELIVERED_EXACT = new Set([
  'DELIVERED',
  'SHIPMENT DELIVERED',
  'DELIVERED TO CONSIGNEE',
  'SHIPMENT DELIVERED TO CONSIGNEE',
]);

const FAILURE_PATTERNS = [
  /\bRTO\b/,
  /RETURN(ED)? TO ORIGIN/,
  /\bUNDELIVERED\b/,
  /\bCANCELL?ED\b/,
  /\bCANCELLATION\b/,
  /\bDUPLICATE\b/,
  /\bSHIPMENT RETURNED\b/,
];

const EXCEPTION_PATTERNS = [
  /\bNOT PICKED\b/,
  /\bNOT READY\b/,
  /\bUNSUCCESSFUL\b/,
  /\bPAPERWORK\b/,
  /\bNEXT BUSINESS DAY\b/,
  /\bPICKUP (FAILED|EXCEPTION|REJECTED)\b/,
  /\bREFUSED\b/,
];

const TRANSIT_PATTERNS = [
  /\bIN TRANSIT\b/,
  /\bTRANSIT\b/,
  /\bNETWORK\b/,
  /\bHUB\b/,
  /\bDISPATCHED\b/,
  /\bOUT FOR DELIVERY\b/,
  /\bPICKED UP\b/,
  /\bSHIPMENT PICKED\b/,
  /\bARRIVED\b/,
  /\bCONNECTED\b/,
];

const SCHEDULED_PATTERNS = [/\bREGISTERED\b/, /\bSCHEDULED\b/, /\bPICKUP REQUEST\b/];

/**
 * @param statusType Blue Dart StatusType (e.g. 'DL', 'UD', 'RT', 'PU', 'IT')
 * @param statusDescription Blue Dart Status text
 * @returns the new shipmentStatus, or null when the status is not recognised (leave unchanged)
 */
export const mapBlueDartStatus = (statusType: string | undefined | null, statusDescription: string | undefined | null): TrackedShipmentStatus | null => {
  const type = String(statusType || '').trim().toUpperCase();
  const desc = String(statusDescription || '').trim().toUpperCase().replace(/\s+/g, ' ');

  // 1. Failures (RTO, undelivered, cancelled …) — always win.
  if (type === 'RT' || FAILURE_PATTERNS.some((re) => re.test(desc))) return 'Failed';
  // 2. Pickup exceptions.
  if (EXCEPTION_PATTERNS.some((re) => re.test(desc))) return 'Pickup Exception';
  // 3. Exact delivered.
  if (DELIVERED_EXACT.has(desc) || (type === 'DL' && (desc === '' || desc.startsWith('SHIPMENT DELIVERED') || desc.startsWith('DELIVERED')))) {
    return 'Product Reached';
  }
  // 4. Moving.
  if (TRANSIT_PATTERNS.some((re) => re.test(desc)) || type === 'IT' || type === 'PU') return 'In Transit';
  // 5. Booked, not yet picked up.
  if (SCHEDULED_PATTERNS.some((re) => re.test(desc))) return 'Pickup Scheduled';
  return null;
};

/** Extract the shipment object from Blue Dart's various ShipmentData shapes. */
export const extractShipment = (tracking: any): { StatusType?: string; Status?: string } | null => {
  const shipmentData = tracking?.ShipmentData;
  if (!shipmentData) return null;
  if (Array.isArray(shipmentData)) return shipmentData[0]?.Shipment ?? shipmentData[0] ?? null;
  if (shipmentData.Shipment) return Array.isArray(shipmentData.Shipment) ? shipmentData.Shipment[0] ?? null : shipmentData.Shipment;
  return shipmentData;
};
