/**
 * 统一的线性图标。24×24 画布、1.5 描边、颜色继承 currentColor。
 * 图形按 16px 左右的实际尺寸绘制，保留清楚的内侧留白。
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
    <rect x="3" y="3.75" width="18" height="13.25" rx="2.2" />
    <path d="M12 4v12M4 10h16" />
    <path d="M8 21h8M12 17v4" />
  </>,
);

export const IconLibrary = svg(
  <>
    <rect x="4" y="5" width="15" height="15" rx="2" />
    <path d="M7 3.5h11.5A2.5 2.5 0 0 1 21 6v11.5" />
    <circle cx="9" cy="10" r="1.3" />
    <path d="m5 17 3.5-3.4a1.2 1.2 0 0 1 1.7 0l2.2 2.1 1.3-1.25a1.2 1.2 0 0 1 1.7 0L19 17.9" />
  </>,
);

export const IconFolder = svg(
  <path d="M3.25 7.2a2 2 0 0 1 2-2h4l1.9 2h7.6a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2H5.25a2 2 0 0 1-2-2V7.2Z" />,
);

export const IconFolderPlus = svg(
  <>
    <path d="M3.25 7.2a2 2 0 0 1 2-2h4l1.9 2h7.6a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2H5.25a2 2 0 0 1-2-2V7.2Z" />
    <path d="M12 10.5v6M9 13.5h6" />
  </>,
);

export const IconGlobe = svg(
  <>
    <circle cx="12" cy="12" r="8.75" />
    <path d="M3.5 12h17M12 3.25c2.25 2.35 3.4 5.3 3.4 8.75s-1.15 6.4-3.4 8.75C9.75 18.4 8.6 15.45 8.6 12s1.15-6.4 3.4-8.75Z" />
  </>,
);

export const IconSettings = svg(
  <>
    <path d="M9.8 3.9 10.4 2h3.2l.6 1.9a8.5 8.5 0 0 1 1.7 1l1.9-.6 1.6 2.8-1.4 1.4a8 8 0 0 1 0 2l1.4 1.4-1.6 2.8-1.9-.6a8.5 8.5 0 0 1-1.7 1l-.6 1.9h-3.2l-.6-1.9a8.5 8.5 0 0 1-1.7-1l-1.9.6-1.6-2.8L6 11.5a8 8 0 0 1 0-2L4.6 8.1l1.6-2.8 1.9.6a8.5 8.5 0 0 1 1.7-1Z" transform="translate(0 2)" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

// ---------------- 操作 ----------------

export const IconPlus = svg(<path d="M12 5.25v13.5M5.25 12h13.5" />);
export const IconMinus = svg(<path d="M5.25 12h13.5" />);
export const IconSearch = svg(
  <>
    <circle cx="10.5" cy="10.5" r="6.6" />
    <path d="m15.35 15.35 4.4 4.4" />
  </>,
);
export const IconChevron = svg(<path d="m9 5.5 6.5 6.5L9 18.5" />);
export const IconCheck = svg(<path d="m4.75 12.4 4.55 4.35 9.95-9.5" />);
export const IconExternal = svg(
  <>
    <path d="M13.5 4H20v6.5M19.5 4.5 11 13" />
    <path d="M18 13.25v5A1.75 1.75 0 0 1 16.25 20h-9.5A1.75 1.75 0 0 1 5 18.25v-9.5A1.75 1.75 0 0 1 6.75 7h5" />
  </>,
);
export const IconLayers = svg(
  <>
    <path d="m12 3.25 8.5 4.5-8.5 4.5-8.5-4.5 8.5-4.5Z" />
    <path d="m4 12 8 4.25 8-4.25M4 16.25l8 4.5 8-4.5" />
  </>,
);
export const IconTrash = svg(
  <>
    <path d="M4 6.75h16M9 6.75V4.5c0-.55.45-1 1-1h4c.55 0 1 .45 1 1v2.25" />
    <path d="m6.25 7.25.8 11.1a1.75 1.75 0 0 0 1.75 1.65h6.4a1.75 1.75 0 0 0 1.75-1.65l.8-11.1M10 10v7M14 10v7" />
  </>,
);
export const IconRefresh = svg(
  <>
    <path d="M20 5v5h-5" />
    <path d="M19.2 10A7.5 7.5 0 1 0 19 15" />
  </>,
);
export const IconImage = svg(
  <>
    <rect x="3.5" y="4.25" width="17" height="15.5" rx="2" />
    <circle cx="9" cy="9.5" r="1.45" />
    <path d="m4.25 17 4.55-4.35a1.45 1.45 0 0 1 2.05 0l2.35 2.25 1.7-1.65a1.45 1.45 0 0 1 2.05 0l2.8 2.7" />
  </>,
);
export const IconMore = svg(
  <>
    <circle cx="5.25" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="18.75" cy="12" r="1" fill="currentColor" stroke="none" />
  </>,
);
export const IconFolderMove = svg(
  <>
    <path d="M3.25 7.2a2 2 0 0 1 2-2h4l1.9 2h7.6a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5.25a2 2 0 0 1-2-2V7.2Z" />
    <path d="M8 13.5h7.75m-2.5-2.5 2.5 2.5-2.5 2.5" />
  </>,
);
export const IconMonitor = svg(
  <>
    <rect x="3" y="4" width="18" height="13" rx="2" />
    <path d="M8 21h8m-4-4v4" />
    <path d="m7 13.5 3.25-3.1a1.2 1.2 0 0 1 1.7 0l1.2 1.15 1.1-1.05a1.2 1.2 0 0 1 1.7 0l1.05 1" />
  </>,
);
export const IconSparkle = svg(
  <>
    <path d="m12 3.25 1.75 5.5 5.5 1.75-5.5 1.75L12 17.75l-1.75-5.5-5.5-1.75 5.5-1.75L12 3.25Z" />
    <path d="m19 16 .8 2.2 2.2.8-2.2.8L19 22l-.8-2.2-2.2-.8 2.2-.8L19 16Z" />
  </>,
);
export const IconArrowLeft = svg(<path d="m15.5 5.5-6.5 6.5 6.5 6.5M9.25 12h10" />);
export const IconFolderScan = svg(
  <>
    <path d="M3.25 7.2a2 2 0 0 1 2-2h4l1.9 2h7.6a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2H5.25a2 2 0 0 1-2-2V7.2Z" />
    <path d="M8 13.4h.01M12 13.4h.01M16 13.4h.01" />
  </>,
);
export const IconClose = svg(<path d="m6.5 6.5 11 11m0-11-11 11" />);
export const IconExpand = svg(
  <>
    <path d="M4 9V5.75C4 4.78 4.78 4 5.75 4H9M15 4h3.25c.97 0 1.75.78 1.75 1.75V9M20 15v3.25c0 .97-.78 1.75-1.75 1.75H15M9 20H5.75C4.78 20 4 19.22 4 18.25V15" />
  </>,
);

export const IconGrid = svg(<><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>);
export const IconList = svg(<><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></>);

export const IconHeart = svg(<path d="M20.8 4.8a5.2 5.2 0 0 0-7.4 0L12 6.2l-1.4-1.4a5.2 5.2 0 0 0-7.4 7.4L12 21l8.8-8.8a5.2 5.2 0 0 0 0-7.4Z" />);

export const IconSort = svg(<><path d="M7 4v16m-3-3 3 3 3-3M17 20V4m-3 3 3-3 3 3" /></>);

export const IconInfo = svg(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>);
