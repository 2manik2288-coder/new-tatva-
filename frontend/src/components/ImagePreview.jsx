import { X } from 'lucide-react';

export default function ImagePreview({ imageUrl, onRemove }) {
  if (!imageUrl) return null;

  return (
    <div className="relative inline-block">
      <img
        src={imageUrl}
        alt="Upload preview"
        className="h-16 w-16 object-cover rounded-xl border border-[var(--border-glass)]"
      />
      {onRemove && (
        <button
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500/90 rounded-full flex items-center justify-center hover:bg-red-500 transition-default"
        >
          <X size={12} className="text-white" />
        </button>
      )}
    </div>
  );
}
