import type { ComponentChild, CSSProperties } from 'preact';
import type { RichNode } from '../../engine/modules/ui';

export interface RichTextProps {
    nodes: readonly RichNode[];
    class?: string;
    /** `\i[id]` 图标 → 图片地址 */
    resolveIcon?: (id: string) => string | undefined;
}

function renderNode(
    node: RichNode,
    key: number,
    resolveIcon?: (id: string) => string | undefined,
): ComponentChild {
    if (node.type === 'break') return <br key={key} />;
    if (node.type === 'position') return null;
    if (node.type === 'space') return '\u00a0'.repeat(node.count);
    if (node.type === 'icon') {
        const src = resolveIcon?.(node.id);
        return src ? (
            <img key={key} class="mota-inline-icon" src={src} alt={node.id} />
        ) : (
            <span key={key} class="mota-inline-icon" data-icon={node.id} />
        );
    }
    const style: CSSProperties = {};
    if (node.color) style.color = node.color;
    if (node.bold) style.fontWeight = 'bold';
    if (node.italic) style.fontStyle = 'italic';
    if (node.fontSize) style.fontSize = `${node.fontSize}px`;
    if (node.font) style.fontFamily = node.font;
    return (
        <span key={key} style={style}>
            {node.text}
        </span>
    );
}

/** 富文本节点 → DOM（`\n` / `\c[]` / `\i[]` 等标记已在 engine 解析成 `RichNode[]`） */
export function RichText({ nodes, class: className, resolveIcon }: RichTextProps) {
    return (
        <span class={className}>
            {nodes.map((node, index) => renderNode(node, index, resolveIcon))}
        </span>
    );
}
