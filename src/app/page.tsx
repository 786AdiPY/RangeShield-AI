import styles from './page.module.css';

export default function Home() {
  return (
    <main className={styles.main}>
      <div className={styles.content}>
        <h1 className={styles.title}>RangeShield AI</h1>
        <p className={styles.description}>
          Optimising energy consumption and AI-driven guidance tailored to your route, your vehicle, and your driving style.
        </p>
      </div>
      <div className={styles.visual}></div>
    </main>
  );
}
