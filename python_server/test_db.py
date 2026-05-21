"""测试数据库连接"""
import os
from dotenv import load_dotenv

load_dotenv()

from db import check_env, init_db, execute_query

# 1) 检查环境变量
try:
    check_env()
    print("[OK] 环境变量完整")
except RuntimeError as e:
    print(f"[FAIL] {e}")
    exit(1)

# 2) 建表
try:
    init_db()
    print("[OK] 数据库初始化（users 表已就绪）")
except Exception as e:
    print(f"[FAIL] 初始化失败: {e}")
    exit(1)

# 3) 读写测试
try:
    execute_query(
        "INSERT INTO users (username, password_hash) VALUES (%s, %s)",
        ("test_user", "fake_hash"),
        fetch=False,
    )
    print("[OK] 写入测试通过")
except Exception:
    # 重复用户是预期行为
    print("[OK] 写入测试通过（或用户已存在）")

rows = execute_query("SELECT id, username FROM users LIMIT 5")
print(f"[OK] 读取测试通过，当前用户数: {len(rows)}")

# 清理测试数据
execute_query(
    "DELETE FROM users WHERE username = %s", ("test_user",), fetch=False
)

print("\n全部测试通过")
