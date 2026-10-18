/**
 * One order line in the "Select items" step: selection checkbox, lock/badge
 * state, and (when selected) the request form with the photo picker.
 */
import React, { memo } from 'react';
import { AlertCircle, Camera, Check, History, Info, Loader2, PackageOpen, Trash2 } from 'lucide-react';
import type { PublicLineItem } from '../../Interfaces/publicApi';
import {
  ItemDetails, MANDATORY_IMAGES, MAX_IMAGES, MIN_NOTE_WORDS, RETURN_REASONS, SelectedImage,
  countWords, isNoteRequired, isValidAdditionalNote,
} from './customerUtils';

export type ItemLock =
  | { kind: 'none' }
  | { kind: 'active'; status: string }
  | { kind: 'custom' }
  | { kind: 'exhausted' };

export interface ItemCardProps {
  item: PublicLineItem;
  currency: string;
  productImage: string | null;
  isSelected: boolean;
  details: ItemDetails;
  images: (SelectedImage | null)[];
  lock: ItemLock;
  /** Maximum quantity the customer may still request for this line. */
  maxQty: number;
  /** Days left in the return window when it is about to close, else null. */
  daysLeft: number | null;
  processingImages: boolean;
  onToggle: (lineItemId: number) => void;
  onUpdate: (lineItemId: number, field: keyof ItemDetails, value: string | number) => void;
  onFiles: (lineItemId: number, files: File[]) => void;
  onRemoveImage: (lineItemId: number, index: number) => void;
}

const ItemCardInner = ({
  item, currency, productImage, isSelected, details, images, lock, maxQty, daysLeft, processingImages,
  onToggle, onUpdate, onFiles, onRemoveImage,
}: ItemCardProps) => {
  const isDisabled = lock.kind !== 'none';
  const uploadedCount = images.filter(Boolean).length;
  const noteRequired = isNoteRequired(details.reason);
  const noteInvalid = noteRequired && !isValidAdditionalNote(details.note);
  const firstEmpty = images.findIndex((img) => !img);
  const ids = {
    qty: `qty-${item.id}`,
    reason: `reason-${item.id}`,
    note: `note-${item.id}`,
    noteHint: `note-hint-${item.id}`,
    files: `files-${item.id}`,
    uploadHint: `upload-hint-${item.id}`,
    title: `item-title-${item.id}`,
  };
  const validProps = Array.isArray(item.properties)
    ? item.properties.filter((p) => p?.name && p?.value !== undefined && p?.value !== null && String(p.value) !== '')
    : [];
  const alreadyRequested = Math.max(0, (item.quantity || 0) - maxQty);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) onFiles(item.id, files);
  };

  return (
    <div className={`rg-item-card${isDisabled ? ' disabled' : isSelected ? ' selected' : ''}`}>
      <div className="rg-item-header">
        <button
          type="button"
          role="checkbox"
          aria-checked={isSelected}
          aria-disabled={isDisabled}
          aria-labelledby={ids.title}
          className={`rg-checkbox${isDisabled ? ' disabled' : isSelected ? ' checked' : ''}`}
          onClick={() => { if (!isDisabled) onToggle(item.id); }}
        >
          {isSelected && <Check size={14} strokeWidth={3} aria-hidden="true" />}
        </button>

        <div className="rg-item-img">
          {productImage ? (
            <img src={productImage} alt={item.title} className={isDisabled ? 'grayscale' : ''} loading="lazy" />
          ) : (
            <PackageOpen size={24} className="rg-placeholder-icon" aria-hidden="true" />
          )}
        </div>

        <div className="rg-item-info">
          <h3 className={`rg-item-title${isDisabled ? ' muted' : ''}`} id={ids.title}>{item.title}</h3>
          <p className="rg-item-variant">Variant: {item.variant_title || 'Default'}</p>
          {validProps.length > 0 && (
            <div className="rg-item-props">
              {validProps.map((prop, idx) => (
                <span key={idx} className="rg-prop-tag">{prop.name}: {String(prop.value)}</span>
              ))}
            </div>
          )}
          <p className="rg-item-price">{item.price} {currency}</p>
        </div>

        <div className="rg-item-badges">
          {lock.kind === 'active' && (
            <span className="rg-badge amber"><AlertCircle size={11} aria-hidden="true" /> {lock.status}</span>
          )}
          {lock.kind === 'exhausted' && (
            <span className="rg-badge slate"><History size={11} aria-hidden="true" /> Requested</span>
          )}
          {lock.kind === 'custom' && <span className="rg-badge red"><AlertCircle size={11} aria-hidden="true" /> Custom</span>}
        </div>
      </div>

      {daysLeft !== null && !isDisabled && (
        <div className="rg-item-alert orange">
          <AlertCircle size={14} aria-hidden="true" />
          <span>Return window closes in {daysLeft} day(s). Please submit soon.</span>
        </div>
      )}
      {lock.kind === 'active' && (
        <div className="rg-item-alert amber">
          <Info size={14} aria-hidden="true" />
          <span>Return in progress ({lock.status}). Reapply after closure.</span>
        </div>
      )}
      {lock.kind === 'exhausted' && (
        <div className="rg-item-alert slate">
          <Info size={14} aria-hidden="true" />
          <span>All units of this item have already been requested for return or exchange.</span>
        </div>
      )}
      {lock.kind === 'custom' && (
        <div className="rg-item-alert slate">
          <Info size={14} aria-hidden="true" />
          <span>Non-returnable due to customization.</span>
        </div>
      )}

      {isSelected && !isDisabled && (
        <div className="rg-item-form">
          <fieldset className="rg-form-section" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="rg-field-label">Request Type <span style={{ color: 'var(--raspberry)' }} aria-hidden="true">*</span></legend>
            <div className="rg-radio-group">
              <label className={`rg-radio-label${details.actionType === 'return' ? ' active' : ''}`}>
                <input type="radio" name={`actionType-${item.id}`} value="return" checked={details.actionType === 'return'}
                  onChange={() => onUpdate(item.id, 'actionType', 'return')} />
                Return Product
              </label>
              <label className={`rg-radio-label${details.actionType === 'exchange' ? ' active' : ''}`}>
                <input type="radio" name={`actionType-${item.id}`} value="exchange" checked={details.actionType === 'exchange'}
                  onChange={() => onUpdate(item.id, 'actionType', 'exchange')} />
                Exchange Product
              </label>
            </div>
          </fieldset>

          <div className="rg-form-row">
            <div>
              <label className="rg-field-label" htmlFor={ids.qty}>Quantity</label>
              <select id={ids.qty} value={details.qty} onChange={(e) => onUpdate(item.id, 'qty', parseInt(e.target.value, 10) || 1)} className="rg-select">
                {Array.from({ length: Math.max(1, maxQty) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              {alreadyRequested > 0 && (
                <p className="rg-qty-hint">{alreadyRequested} of {item.quantity} already requested earlier.</p>
              )}
            </div>

            <div>
              <label className="rg-field-label" htmlFor={ids.reason}>Reason for {details.actionType === 'exchange' ? 'Exchange' : 'Return'}</label>
              <select id={ids.reason} value={details.reason} onChange={(e) => onUpdate(item.id, 'reason', e.target.value)} className="rg-select" aria-required="true">
                <option value="" disabled>Select a reason...</option>
                {RETURN_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="rg-field-label" htmlFor={ids.note}>
              Additional Notes {noteRequired
                ? <span style={{ color: 'var(--raspberry)' }} aria-hidden="true">*</span>
                : <span style={{ color: 'var(--muted)', fontWeight: 500 }}>(Optional)</span>}
            </label>
            <input
              id={ids.note}
              type="text"
              value={details.note}
              maxLength={500}
              onChange={(e) => onUpdate(item.id, 'note', e.target.value)}
              placeholder={noteRequired ? `Please describe the issue (min ${MIN_NOTE_WORDS} words)...` : 'Add details...'}
              className={`rg-input no-icon${noteInvalid && details.note ? ' error' : ''}`}
              aria-required={noteRequired}
              aria-invalid={noteInvalid && !!details.note}
              aria-describedby={noteRequired ? ids.noteHint : undefined}
            />
            {noteRequired && (
              <p id={ids.noteHint} className={noteInvalid && details.note ? 'rg-field-error' : 'rg-qty-hint'}>
                Required for this reason — at least {MIN_NOTE_WORDS} words ({countWords(details.note)} so far).
              </p>
            )}
          </div>

          <div>
            <div className="rg-upload-header">
              <span className="rg-field-label" style={{ marginBottom: 0 }}>Upload Images</span>
              <span className={`rg-badge${uploadedCount >= MANDATORY_IMAGES ? ' green' : ' amber'}`} aria-label={`${uploadedCount} of ${MAX_IMAGES} photos added`}>
                {uploadedCount}/{MAX_IMAGES}
              </span>
            </div>
            <p className="rg-upload-hint" id={ids.uploadHint}>
              <span style={{ color: 'var(--plum)', fontWeight: 700 }}>{MANDATORY_IMAGES} required</span> · Max {MAX_IMAGES} · JPEG, PNG, WebP or HEIC
              {processingImages && <> · <Loader2 size={11} className="rg-spin" aria-hidden="true" /> Preparing photos…</>}
            </p>
            <div className="rg-upload-grid">
              {images.map((img, index) => {
                const isRequired = index < MANDATORY_IMAGES;
                return (
                  <div key={index} className={`rg-upload-slot${isRequired ? ' required' : ''}${img ? ' has-file' : ''}`}>
                    {img ? (
                      <>
                        <img src={img.url} alt={`Your photo ${index + 1} of ${item.title}`} className="rg-upload-preview" />
                        <button
                          type="button"
                          onClick={() => onRemoveImage(item.id, index)}
                          className="rg-upload-remove"
                          aria-label={`Remove photo ${index + 1} of ${item.title}`}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <label htmlFor={ids.files} className="rg-upload-empty">
                        <Camera size={16} style={{ color: isRequired ? 'var(--raspberry)' : 'var(--muted)' }} aria-hidden="true" />
                        <span aria-hidden="true">{isRequired ? 'Required' : 'Optional'}</span>
                        {index === firstEmpty && (
                          <input
                            id={ids.files}
                            className="rg-sr-only"
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/heic,.heic"
                            multiple
                            disabled={processingImages}
                            aria-label={`Add photos of ${item.title}`}
                            aria-describedby={ids.uploadHint}
                            onChange={handleFileInput}
                          />
                        )}
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export const ItemCard = memo(ItemCardInner);
