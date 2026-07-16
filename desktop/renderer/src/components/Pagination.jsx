import { ChevronLeft, ChevronRight } from 'lucide-react';

export function Pagination({ page, pageSize, total, onPageChange, noun = '条' }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = total ? (safePage - 1) * pageSize + 1 : 0;
  const end = Math.min(safePage * pageSize, total);

  if (total <= pageSize) {
    return total ? <div className="pagination-summary">共 {total} {noun}</div> : null;
  }

  return (
    <div className="pagination" aria-label="分页导航">
      <span>{start}-{end} / {total} {noun}</span>
      <button
        type="button"
        className="icon-button"
        onClick={() => onPageChange(safePage - 1)}
        disabled={safePage <= 1}
        title="上一页"
        aria-label="上一页"
      >
        <ChevronLeft size={16} />
      </button>
      <strong>{safePage} / {totalPages}</strong>
      <button
        type="button"
        className="icon-button"
        onClick={() => onPageChange(safePage + 1)}
        disabled={safePage >= totalPages}
        title="下一页"
        aria-label="下一页"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
