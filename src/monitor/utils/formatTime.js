export default function formatTime(Timestamp) {
  let date1 = new Date(Timestamp);
  return date1.toLocaleDateString().replace(/\//g, "-") + " " + date1.toTimeString().substr(0, 8); 
}
