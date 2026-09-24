"""
Script tạo nhiều file .txt theo danh sách tên, trong một folder do người dùng nhập.

Cách dùng:
    python create_txt_files.py
"""

import os


LIST_FOLDER = [
'2026-06-11',
'2026-06-09',
'2026-06-07',
'2026-06-02',
'2026-05-31',
]

FOLDER_PATH = r"C:\Users\Admin\Documents\Python\auto-script\samples\translate\france_korea"

def create_txt_files(names: list[str], folder_path: str, content: str = "") -> None:
    """
    Tạo file .txt cho mỗi tên trong `names`, lưu vào `folder_path`.

    - Nếu folder chưa tồn tại, sẽ tự tạo.
    - Nếu tên đã có sẵn đuôi .txt thì giữ nguyên, không có thì tự thêm.
    """
    # Tạo folder nếu chưa có
    os.makedirs(folder_path, exist_ok=True)

    created = []
    skipped = []

    for name in names:
        name = name.strip()
        if not name:
            continue

        # Đảm bảo có đuôi .txt
        filename = name if name.lower().endswith(".txt") else f"{name}.txt"

        # Loại bỏ ký tự không hợp lệ trong tên file (Windows)
        invalid_chars = '<>:"/\\|?*'
        safe_filename = "".join(c for c in filename if c not in invalid_chars)

        file_path = os.path.join(folder_path, safe_filename)

        try:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(content)
            created.append(file_path)
        except Exception as e:
            skipped.append((name, str(e)))

    print(f"\nĐã tạo {len(created)} file:")
    for p in created:
        print(f"  - {p}")

    if skipped:
        print(f"\nKhông tạo được {len(skipped)} file:")
        for name, err in skipped:
            print(f"  - {name}: {err}")


def main():

    create_txt_files(LIST_FOLDER, FOLDER_PATH)


if __name__ == "__main__":
    main()