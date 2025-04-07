import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const { question } = await req.json()

  // Giả lập phản hồi từ AI dựa trên nội dung câu hỏi
  const mockReply = {
    lop: "12",
    chuDe: "Nhiệt học – Cấu tạo chất",
    mucDo: "Thông hiểu",
    nangLuc: "VL1.2 – Trình bày hiện tượng vật lí",
    loaiCau: "Trắc nghiệm lý thuyết"
  }

  // Giả lập định dạng như phản hồi thật từ OpenAI
  const reply = `{
    "lop": "${mockReply.lop}",
    "chuDe": "${mockReply.chuDe}",
    "mucDo": "${mockReply.mucDo}",
    "nangLuc": "${mockReply.nangLuc}",
    "loaiCau": "${mockReply.loaiCau}"
  }`

  return NextResponse.json({ reply })
}
