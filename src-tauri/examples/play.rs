fn main() {
    let path = std::env::args().nth(1).expect("usage: play <file.wav>");
    let device = rodio::DeviceSinkBuilder::open_default_sink().expect("device");
    let player = rodio::Player::connect_new(device.mixer());
    let file = std::fs::File::open(&path).expect("open");
    let source = rodio::Decoder::new_wav(std::io::BufReader::new(file)).expect("decode");
    player.append(source);
    let mut idle = std::time::Instant::now();
    loop {
        std::thread::sleep(std::time::Duration::from_millis(40));
        if player.empty() {
            if idle.elapsed() > std::time::Duration::from_secs(6) {
                break;
            }
        } else {
            idle = std::time::Instant::now();
        }
    }
}
