import { useEffect, useState } from 'react';

export default function SelectedFilePreview({ files, logoFile }) {
  const [previews, setPreviews] = useState([]);
  useEffect(() => {
    const next = files.map(file => ({ name: file.name, role: file === logoFile ? 'Brand logo' : 'Brand photo', url: URL.createObjectURL(file) }));
    setPreviews(next);
    return () => next.forEach(item => URL.revokeObjectURL(item.url));
  }, [files, logoFile]);
  if (!previews.length) return null;
  return <div className="selected-source-previews" aria-label="Selected brand images">
    {previews.map((item, index) => <figure key={`${item.name}-${index}`}><img src={item.url} alt={item.name} /><figcaption>{item.role} · {item.name}</figcaption></figure>)}
  </div>;
}
