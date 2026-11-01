import { HardDrive, Send, SlidersHorizontal, Sparkles } from "lucide-react";

export const settingsSections = [
  {
    id: "defaults",
    label: "پیش‌فرض‌های ویرایش",
    description: "پیش‌تنظیم‌های کپشن و واترمارک",
    icon: SlidersHorizontal,
  },
  {
    id: "subtitles",
    label: "زیرنویس خودکار",
    description: "زیرنویس، کپشن و 9Router",
    icon: Sparkles,
  },
  {
    id: "telegram",
    label: "Telegram",
    description: "ربات، کانال‌ها و ارسال",
    icon: Send,
  },
  {
    id: "storage",
    label: "فضای ذخیره‌سازی",
    description: "فضا و پاک‌سازی",
    icon: HardDrive,
  },
] as const;

export type SettingsSectionId = (typeof settingsSections)[number]["id"];
