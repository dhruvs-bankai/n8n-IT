"""Generates data/it-inventory.xlsx - the employee/system sheet the AI reads.

Run:  python scripts/make-inventory.py
Edit the ROWS list (or the xlsx directly in Excel) and commit the file.
"""
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

HEADERS = [
    "employee_id", "name", "email", "department", "role", "start_date",
    "manager_email", "location", "employment_status", "device_asset_tag",
    "device_model", "os_version", "ram_gb", "storage_gb", "installed_software",
    "vpn_access", "last_backup", "notes",
]

ROWS = [
    ["EMP-101", "Ali Raza", "ali.raza@example.com", "Finance", "Accounts Officer",
     "2023-04-17", "manager.finance@example.com", "Karachi HQ", "permanent",
     "IT-LT-1001", "Dell Latitude 5440", "Windows 11 Pro 23H2", 16, 512,
     "Microsoft 365; Google Chrome; 7-Zip; Zoom", "yes", "2026-11-23",
     "Device is 20 months old; warranty until 2028-02."],
    ["EMP-102", "Sara Khan", "sara.khan@example.com", "Engineering", "Backend Developer",
     "2026-11-02", "manager.eng@example.com", "Karachi HQ", "permanent",
     "IT-LT-1003", "Lenovo ThinkPad T14", "Ubuntu 24.04 LTS", 32, 1024,
     "VS Code; Git; Docker; Slack", "yes", "2026-11-23",
     "New joiner, probation ends 2027-02-02."],
    ["EMP-103", "Bilal Ahmed", "bilal.ahmed@example.com", "Sales", "Account Executive",
     "2024-08-12", "manager.sales@example.com", "Lahore Office", "permanent",
     "IT-LT-1002", "Dell Latitude 5440", "Windows 11 Pro 23H2", 16, 512,
     "Microsoft 365; Google Chrome; Teams; Zoom", "yes", "2026-11-22", ""],
    ["EMP-104", "Hina Iqbal", "hina.iqbal@example.com", "Design", "UI Designer",
     "2022-01-10", "manager.design@example.com", "Remote", "permanent",
     "IT-LT-1004", "MacBook Pro 14 (M3)", "macOS 15.1", 18, 512,
     "Figma; Adobe Acrobat Pro; Slack; Chrome", "yes", "2026-11-21",
     "Mac device - use brew for installs."],
    ["EMP-105", "Usman Tariq", "usman.tariq@example.com", "Engineering", "QA Engineer",
     "2025-06-01", "manager.eng@example.com", "Karachi HQ", "permanent",
     "IT-LT-1005", "Dell Latitude 5430", "Windows 11 Pro 23H2", 16, 512,
     "VS Code; Postman; Chrome; 7-Zip", "yes", "2026-11-23", ""],
    ["EMP-106", "Ayesha Siddiqui", "ayesha.siddiqui@example.com", "HR", "HR Officer",
     "2026-11-15", "manager.hr@example.com", "Islamabad Office", "probation",
     "IT-LT-1006", "HP ProBook 450", "Windows 11 Pro 23H2", 8, 256,
     "Microsoft 365; Chrome; Zoom", "no", "2026-11-20",
     "Probation - no asset allocation without HR approval."],
    ["EMP-107", "Imran Sheikh", "imran.sheikh@example.com", "Engineering", "DevOps Engineer",
     "2021-03-22", "manager.eng@example.com", "Remote", "permanent",
     "IT-LT-1007", "Dell XPS 15", "Ubuntu 24.04 LTS", 32, 1024,
     "VS Code; Docker; Terraform; Slack; Firefox", "yes", "2026-11-23", ""],
    ["EMP-108", "Zara Malik", "zara.malik@example.com", "Sales", "Sales Manager",
     "2020-09-09", "director.sales@example.com", "Lahore Office", "permanent",
     "IT-LT-1008", "Dell Latitude 7440", "Windows 11 Pro 23H2", 16, 512,
     "Microsoft 365; Teams; Zoom; Acrobat Reader", "yes", "2026-11-23", ""],
]


def main():
    out = os.path.join(os.path.dirname(__file__), "..", "data", "it-inventory.xlsx")
    out = os.path.abspath(out)
    wb = Workbook()
    ws = wb.active
    ws.title = "employees"
    ws.append(HEADERS)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1F4E79")
    for row in ROWS:
        ws.append(row)
    widths = [12, 20, 30, 14, 22, 12, 28, 16, 16, 16, 26, 22, 8, 11, 46, 11, 12, 46]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    wb.save(out)
    print("wrote", out, "rows:", len(ROWS))


if __name__ == "__main__":
    main()
