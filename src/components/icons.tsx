/**
 * 全站图标集。
 *
 * 统一用 1.5 描边的 24×24 线性图标，尺寸由 `size` 控制、颜色继承 `currentColor`。
 * 不引入图标库：本项目只用到十几个图标，自带一份可以避免多一个依赖，
 * 也保证不同图标之间的笔画粗细完全一致（混用图标库最容易出现的问题）。
 */

interface IconProps {
  size?: number;
  className?: string;
}

function svg(path: React.ReactNode, viewBox = "0 0 24 24") {
  return function Icon({ size = 16, className }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={viewBox}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden
      >
        {path}
      </svg>
    );
  };
}

// ---------------- 导航 ----------------

export const IconDisplay = svg(
  <>
    <rect x="2.5" y="4" width="19" height="13" rx="1.8" />
    <path d="M8.5 21h7M12 17v4" />
  </>,
);

export const IconLibrary = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.6" cy="9.4" r="1.6" />
    <path d="M3.4 17.2l4.6-4.3a1.6 1.6 0 0 1 2.2 0l3 2.9M13.4 15.2l2-1.9a1.6 1.6 0 0 1 2.2 0l3.1 3" />
  </>,
);

export const IconFolder = svg(
  <path d="M3 7.2c0-1 .8-1.8 1.8-1.8h3.6c.5 0 1 .2 1.3.6l1.1 1.2h6.4c1 0 1.8.8 1.8 1.8v7.8c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8V7.2z" />,
);

export const IconFolderPlus = svg(
  <>
    <path d="M3 7.2c0-1 .8-1.8 1.8-1.8h3.6c.5 0 1 .2 1.3.6l1.1 1.2h6.4c1 0 1.8.8 1.8 1.8v7.8c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8V7.2z" />
    <path d="M12 11.5v5M9.5 14h5" />
  </>,
);

export const IconGlobe = svg(
  <>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M3.4 12h17.2M12 3.4c2.2 2.3 3.4 5.4 3.4 8.6s-1.2 6.3-3.4 8.6c-2.2-2.3-3.4-5.4-3.4-8.6S9.8 5.7 12 3.4z" />
  </>,
);

export const IconSettings = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.1M12 19.1v2.1M4.8 4.8l1.5 1.5M17.7 17.7l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.8 19.2l1.5-1.5M17.7 6.3l1.5-1.5" />
  </>,
);

// ---------------- 操作 ----------------

export const IconPlus = svg(<path d="M12 5v14M5 12h14" />);
export const IconSearch = svg(
  <>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="M15.4 15.4l4 4" />
  </>,
);
export const IconChevron = svg(<path d="M9 6l6 6-6 6" />);
export const IconCheck = svg(<path d="M5 12.6l4.6 4.4L19 7" />);
export const IconExternal = svg(
  <>
    <path d="M14 4h6v6M20 4l-8.4 8.4" />
    <path d="M18 14.2v4.6c0 1-.8 1.8-1.8 1.8H5.2c-1 0-1.8-.8-1.8-1.8V7.8C3.4 6.8 4.2 6 5.2 6h4.6" />
  </>,
);
export const IconLayers = svg(
  <>
    <path d="M12 3.2l8.4 4.4L12 12 3.6 7.6 12 3.2z" />
    <path d="M3.6 12.4L12 16.8l8.4-4.4M3.6 16.8L12 21.2l8.4-4.4" />
  </>,
);
export const IconTrash = svg(
  <>
    <path d="M4 7h16M9.5 7V5.2c0-.7.5-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7" />
    <path d="M6.2 7l.8 12.1c0 .9.8 1.7 1.7 1.7h6.6c.9 0 1.7-.8 1.7-1.7L17.8 7" />
  </>,
);
export const IconRefresh = svg(
  <>
    <path d="M20 5.6v5h-5" />
    <path d="M19.4 10.6a7.6 7.6 0 1 0-1.6 6.1" />
  </>,
);
export const IconImage = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.6" cy="9.4" r="1.6" />
    <path d="M3.4 17.6l4.8-4.5a1.6 1.6 0 0 1 2.2 0l2.8 2.7M13.4 15.4l1.8-1.7a1.6 1.6 0 0 1 2.2 0l3.2 3" />
  </>,
);
export const IconMore = svg(
  <>
    <circle cx="6" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="18" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </>,
);
export const IconFolderMove = svg(
  <>
    <path d="M3 7.2c0-1 .8-1.8 1.8-1.8h3.6c.5 0 1 .2 1.3.6l1.1 1.2h6.4c1 0 1.8.8 1.8 1.8v7.8c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8V7.2z" />
    <path d="M9.6 13.4h5.2M12.9 11l2.4 2.4-2.4 2.4" />
  </>,
);
export const IconMonitor = svg(
  <>
    <rect x="2.5" y="4" width="19" height="13" rx="1.8" />
    <path d="M8.5 21h7M12 17v4" />
  </>,
);
export const IconSparkle = svg(
  <>
    <path d="M12 3.5l1.9 4.9 4.9 1.9-4.9 1.9L12 17.1l-1.9-4.9-4.9-1.9 4.9-1.9L12 3.5z" />
    <path d="M18.6 16.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" />
  </>,
);
export const IconArrowLeft = svg(<path d="M15 5l-7 7 7 7" />);
export const IconFolderScan = svg(
  <>
    <path d="M3 7.2c0-1 .8-1.8 1.8-1.8h3.6c.5 0 1 .2 1.3.6l1.1 1.2h6.4c1 0 1.8.8 1.8 1.8v7.8c0 1-.8 1.8-1.8 1.8H4.8c-1 0-1.8-.8-1.8-1.8V7.2z" />
    <path d="M8.4 12.6h.01M11.2 12.6h.01M14 12.6h.01" />
  </>,
);
export const IconClose = svg(<path d="M6 6l12 12M18 6L6 18" />);
export const IconExpand = svg(
  <>
    <path d="M4 9V5.6c0-.9.7-1.6 1.6-1.6H9M15 4h3.4c.9 0 1.6.7 1.6 1.6V9M20 15v3.4c0 .9-.7 1.6-1.6 1.6H15M9 20H5.6c-.9 0-1.6-.7-1.6-1.6V15" />
  </>,
);

