use std::io::Cursor;
use std::time::Instant;

fn main() {
    for &(label, width, height, fill) in &[
        ("pattern", 1280u32, 720u32, false),
        ("noise", 1280u32, 720u32, true),
        ("pattern", 640u32, 360u32, false),
        ("noise", 640u32, 360u32, true),
    ] {
        let mut rgb = vec![0u8; (width * height * 3) as usize];
        for (i, chunk) in rgb.chunks_exact_mut(3).enumerate() {
            if fill {
                let x = ((i as u64).wrapping_mul(6364136223846793005).wrapping_add(1) >> 33) as u8;
                let y = ((i as u64).wrapping_mul(1442695040888963407).wrapping_add(7) >> 33) as u8;
                let z = ((i as u64).wrapping_mul(1181783497276652981).wrapping_add(13) >> 33) as u8;
                chunk[0] = x;
                chunk[1] = y;
                chunk[2] = z;
            } else {
                chunk[0] = (i % 255) as u8;
                chunk[1] = ((i / 255) % 255) as u8;
                chunk[2] = ((i * 3) % 255) as u8;
            }
        }
        let _ = encode_png(&rgb, width, height);
        let _ = encode_jpeg(&rgb, width, height);
        let mut png_ms = Vec::new();
        let mut jpeg_ms = Vec::new();
        let mut b64_png = Vec::new();
        let mut b64_jpeg = Vec::new();
        let mut png_bytes = 0usize;
        let mut jpeg_bytes = 0usize;
        for _ in 0..6 {
            let s = Instant::now();
            let png = encode_png(&rgb, width, height);
            png_ms.push(s.elapsed().as_secs_f64() * 1000.0);
            png_bytes = png.len();
            let s = Instant::now();
            let _ = base64_encode(&png);
            b64_png.push(s.elapsed().as_secs_f64() * 1000.0);
            let s = Instant::now();
            let jpeg = encode_jpeg(&rgb, width, height);
            jpeg_ms.push(s.elapsed().as_secs_f64() * 1000.0);
            jpeg_bytes = jpeg.len();
            let s = Instant::now();
            let _ = base64_encode(&jpeg);
            b64_jpeg.push(s.elapsed().as_secs_f64() * 1000.0);
        }
        let avg = |v: &Vec<f64>| v.iter().sum::<f64>() / v.len() as f64;
        let max = |v: &Vec<f64>| v.iter().cloned().fold(0.0_f64, f64::max);
        println!(
            "{label} {width}x{height}: png encode avg={:.2}ms max={:.2}ms size={} b64={:.2}ms | jpeg encode avg={:.2}ms max={:.2}ms size={} b64={:.2}ms",
            avg(&png_ms), max(&png_ms), png_bytes, avg(&b64_png),
            avg(&jpeg_ms), max(&jpeg_ms), jpeg_bytes, avg(&b64_jpeg)
        );
    }
}

fn encode_png(rgb: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut encoded = Vec::new();
    {
        let mut encoder = png::Encoder::new(Cursor::new(&mut encoded), width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(rgb).unwrap();
    }
    encoded
}

fn encode_jpeg(rgb: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut encoded = Vec::new();
    let encoder = jpeg_encoder::Encoder::new(&mut encoded, 90);
    encoder
        .encode(rgb, width as u16, height as u16, jpeg_encoder::ColorType::Rgb)
        .unwrap();
    encoded
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let mut n = (chunk[0] as u32) << 16;
        if chunk.len() > 1 { n |= (chunk[1] as u32) << 8; }
        if chunk.len() > 2 { n |= chunk[2] as u32; }
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}
