import styles from './page.module.css';

export default function Home() {
  return (
    <main className={styles.main}>
      <div className={styles.content}>
        <h1 className={styles.title}>RangeShield AI</h1>
        <p className={styles.description}>
          Real-time EV co-pilot utilizing Confluent and Vertex AI to predict precise range and optimize energy
        </p>
      </div>
      <div className={styles.visual}></div>
    </main>
  );
}
